// MemoryAnchor — localhost protobuf endpoint.
//
// Anki Desktop's webview reaches the backend by POSTing protobuf to
// `/_anki/<method>` on a loopback HTTP server (see `ts/lib/generated/post.ts`
// and `qt/aqt/mediasrv.py`). Mirroring that contract here means Anki's own
// generated TypeScript client works against this server essentially unchanged.
//
// Note that on iOS a loopback port is reachable by *any* app on the device, so
// every request must carry the bearer token minted at startup.

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;

use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::Path;
use axum::extract::State;
use axum::http::header;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;
use axum::Router;
use tower_http::services::ServeDir;
use tower_http::services::ServeFile;

use crate::routes;

/// Largest package we will accept. Generous, but not unbounded: the body is
/// buffered, and an unbounded one would be an easy way to exhaust memory.
const MAX_UPLOAD_BYTES: usize = 1024 * 1024 * 1024;

/// Anki sends and receives protobuf under this content type.
const PROTO_CONTENT_TYPE: &str = "application/binary";

pub struct AppState {
    pub backend: anki::backend::Backend,
    pub token: String,
    /// Separate credential for the media route, which is the only thing card
    /// content can reach. Card HTML is untrusted author content and the media
    /// URL is visible to it, so leaking this must not expose the collection
    /// API behind the main token.
    pub media_token: String,
    /// Media folder of the open collection, and the directory the app keeps
    /// its own state in. Both are chosen by the caller of `openCollection`,
    /// so they arrive once a collection is opened rather than at startup.
    pub media_root: Mutex<Option<PathBuf>>,
    pub data_dir: Mutex<Option<PathBuf>>,
}

/// Builds the router. When `web_root` is set, the built web UI is served from
/// it so the webview shares an origin with the backend and no CORS is needed.
///
/// Static assets are deliberately unauthenticated — they are inert markup that
/// ships inside the app anyway. The token must therefore never be baked into
/// them; the shell injects it into the webview instead. Only `/_anki/*`, which
/// reaches the collection, requires the token.
pub fn router(state: Arc<AppState>, web_root: Option<PathBuf>) -> Router {
    let api = Router::new()
        .route("/_anki/healthz", get(healthz))
        .route("/_anki/{method}", post(call_unqualified))
        .route("/_anki/{service}/{method}", post(call_qualified))
        // Our own namespace, deliberately outside /_anki/: this is not part of
        // Anki's contract.
        .route("/_anchor/upload", post(upload))
        .route("/_anchor/paths", post(set_paths))
        .route("/_anchor/prefs", get(get_prefs).put(put_prefs))
        .route("/_anchor/media/{token}/{name}", get(media))
        // Collection packages are routinely hundreds of megabytes; axum
        // defaults to a 2 MB body.
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .with_state(state);

    match web_root {
        // Unknown paths fall back to index.html so client-side routing works.
        Some(root) => {
            let index = root.join("index.html");
            api.fallback_service(ServeDir::new(root).fallback(ServeFile::new(index)))
        }
        None => api,
    }
}

/// Liveness plus provenance: which rslib is actually linked in. Anki's build
/// hash comes from `vendor/anki/out/buildhash`, which Anki's own Ninja build
/// writes; `tools/write-buildhash.sh` fills it in for our plain-cargo builds.
async fn healthz(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(resp) = authorize(&headers, &state) {
        return resp;
    }
    let body = serde_json::json!({
        "ok": true,
        "anki": anki::version::buildhash(),
        "memoryanchor": env!("CARGO_PKG_VERSION"),
        "mediaToken": state.media_token,
    })
    .to_string();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response()
}

/// Constant-time-ish bearer check. Returns `Err` with a ready-made response.
fn authorize(headers: &HeaderMap, state: &AppState) -> Result<(), Response> {
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();

    if constant_time_eq(presented.as_bytes(), state.token.as_bytes()) {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "invalid or missing token").into_response())
    }
}

/// Length-independent comparison, so a caller cannot probe the token by timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    diff == 0
}

async fn call_unqualified(
    State(state): State<Arc<AppState>>,
    Path(method): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = authorize(&headers, &state) {
        return resp;
    }
    match routes::lookup(&method) {
        Some((service, method)) => dispatch(&state, service, method, body.to_vec()).await,
        None => (
            StatusCode::NOT_FOUND,
            format!("unknown method: {method}; try /_anki/<Service>/{method}"),
        )
            .into_response(),
    }
}

async fn call_qualified(
    State(state): State<Arc<AppState>>,
    Path((service, method)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = authorize(&headers, &state) {
        return resp;
    }
    match routes::lookup_qualified(&service, &method) {
        Some((service, method)) => dispatch(&state, service, method, body.to_vec()).await,
        None => (
            StatusCode::NOT_FOUND,
            format!("unknown method: {service}/{method}"),
        )
            .into_response(),
    }
}

/// Runs one backend call on a thread of its own.
///
/// Two reasons it cannot run inline. rslib's sync methods own a tokio runtime
/// and `block_on` it, which panics if attempted from inside another runtime —
/// Anki's Python caller is a plain thread, we are an async handler. And the
/// slow operations here (importing a large package, a full sync) would
/// otherwise occupy an async worker and stall every other request.
///
/// Errors come back as protobuf-encoded `BackendError`, forwarded with the
/// status the TypeScript client expects.
async fn dispatch(state: &AppState, service: u32, method: u32, input: Vec<u8>) -> Response {
    let backend = state.backend.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(backend.run_service_method(service, method, &input));
    });

    let outcome = match rx.await {
        Ok(outcome) => outcome,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "backend thread stopped before returning",
            )
                .into_response()
        }
    };

    match outcome {
        Ok(out) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, PROTO_CONTENT_TYPE)],
            out,
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(header::CONTENT_TYPE, PROTO_CONTENT_TYPE)],
            err,
        )
            .into_response(),
    }
}

/// Binds to an ephemeral loopback port and serves until `shutdown` resolves.
/// Returns the bound port so the caller can hand it to the webview.
pub async fn bind(
    state: Arc<AppState>,
    port: u16,
) -> anyhow::Result<(u16, tokio::net::TcpListener)> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let port = listener.local_addr()?.port();
    let _ = &state;
    Ok((port, listener))
}

/// Receives a file and returns the path it was written to, so the caller can
/// hand that path to an rslib method that takes one — `importAnkiPackage`
/// wants a path on disk, not bytes.
///
/// Files land in the process temp directory. On iOS that is the app's own
/// `tmp`, which the system may purge, which is the right lifetime for an
/// import that is consumed immediately.
async fn upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = authorize(&headers, &state) {
        return resp;
    }
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty upload").into_response();
    }

    // The client's filename is untrusted; keep only the extension, which is
    // all rslib needs in order to recognise the format.
    let suffix = headers
        .get("x-anchor-filename")
        .and_then(|v| v.to_str().ok())
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext)
        .filter(|ext| ext.len() <= 16 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("apkg")
        .to_string();

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!("anchor-upload-{nanos}.{suffix}"));

    match tokio::fs::write(&path, &body).await {
        Ok(()) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::json!({ "path": path.to_string_lossy() }).to_string(),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not store upload: {err}"),
        )
            .into_response(),
    }
}

/// Tells the backend where the open collection's media and app state live.
async fn set_paths(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = authorize(&headers, &state) {
        return resp;
    }
    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(err) => return (StatusCode::BAD_REQUEST, format!("bad json: {err}")).into_response(),
    };
    let Some(media) = parsed.get("mediaRoot").and_then(|p| p.as_str()) else {
        return (StatusCode::BAD_REQUEST, "missing 'mediaRoot'").into_response();
    };
    let Some(data) = parsed.get("dataDir").and_then(|p| p.as_str()) else {
        return (StatusCode::BAD_REQUEST, "missing 'dataDir'").into_response();
    };
    *state.media_root.lock().unwrap() = Some(PathBuf::from(media));
    *state.data_dir.lock().unwrap() = Some(PathBuf::from(data));
    StatusCode::NO_CONTENT.into_response()
}

/// Small persistent store for app state that is not Anki's business — most
/// importantly the AnkiWeb sync key.
///
/// This cannot live in the webview: the loopback port is ephemeral, so the
/// page's origin changes on every launch and browser storage is lost with it.
///
/// The file sits in the app sandbox beside the collection, so it is protected
/// the same way the collection is. The sync key is a credential and the
/// Keychain would be a better home for it on iOS; that needs native code and
/// is worth doing before this is relied on widely.
fn prefs_path(state: &AppState) -> Option<PathBuf> {
    state
        .data_dir
        .lock()
        .unwrap()
        .as_ref()
        .map(|dir| dir.join("prefs.json"))
}

async fn get_prefs(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(resp) = authorize(&headers, &state) {
        return resp;
    }
    let Some(path) = prefs_path(&state) else {
        return (StatusCode::CONFLICT, "paths not configured").into_response();
    };
    let body = match tokio::fs::read(&path).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        // No file yet simply means nothing has been stored.
        Err(_) => "{}".to_string(),
    };
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response()
}

async fn put_prefs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = authorize(&headers, &state) {
        return resp;
    }
    if serde_json::from_slice::<serde_json::Value>(&body).is_err() {
        return (StatusCode::BAD_REQUEST, "body must be JSON").into_response();
    }
    let Some(path) = prefs_path(&state) else {
        return (StatusCode::CONFLICT, "paths not configured").into_response();
    };
    match tokio::fs::write(&path, &body).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not save prefs: {err}"),
        )
            .into_response(),
    }
}

/// Serves one file from the collection's media folder, authenticated by a
/// token path segment rather than a header.
///
/// Anki media names are flat, so anything with a directory component or a
/// parent reference is a traversal attempt and is refused outright rather
/// than normalised.
async fn media(
    State(state): State<Arc<AppState>>,
    Path((token, name)): Path<(String, String)>,
) -> Response {
    // An <img> cannot send an Authorization header, so the token arrives as a
    // path segment instead. Same check, different carrier — and a different,
    // weaker credential, since card content can read this URL.
    if !constant_time_eq(token.as_bytes(), state.media_token.as_bytes()) {
        return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response();
    }

    let root = { state.media_root.lock().unwrap().clone() };
    let Some(root) = root else {
        return (StatusCode::NOT_FOUND, "no collection open").into_response();
    };

    let candidate = std::path::Path::new(&name);
    let mut components = candidate.components();
    let single_plain_name = matches!(
        (components.next(), components.next()),
        (Some(std::path::Component::Normal(_)), None)
    );
    if !single_plain_name {
        return (StatusCode::BAD_REQUEST, "invalid media name").into_response();
    }

    match tokio::fs::read(root.join(candidate)).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (
                    header::CONTENT_TYPE,
                    mime_guess::from_path(candidate)
                        .first_or_octet_stream()
                        .to_string(),
                ),
                // Cards render in a sandboxed iframe, whose origin is opaque
                // ("null"). Fonts are CORS-checked even when images are not,
                // so @font-face in card CSS fails without this. Access is
                // still gated on the media token in the path.
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".to_string()),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "no such media file").into_response(),
    }
}
