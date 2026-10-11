// End-to-end proof of the bridge: HTTP request -> route lookup -> protobuf ->
// rslib -> SQLite, and back. If this passes, the Capacitor webview can drive a
// real Anki backend using Anki's own generated TypeScript client.

use memoryanchor_core::routes;
use memoryanchor_core::Instance;
use anki_proto::collection::OpenCollectionRequest;
use anki_proto::decks::DeckNames;
use anki_proto::decks::GetDeckNamesRequest;
use prost::Message;

struct Client {
    inst: Instance,
    http: reqwest::blocking::Client,
}

impl Client {
    fn start() -> Client {
        let inst = Instance::start(&["en".to_string()], 0, false, None).expect("start backend");
        Client {
            inst,
            http: reqwest::blocking::Client::new(),
        }
    }

    /// Mirrors Anki's `postProto`: protobuf in, protobuf out.
    fn call<Req: Message, Resp: Message + Default>(&self, method: &str, req: Req) -> Resp {
        let resp = self.raw(method, req.encode_to_vec(), &self.inst.token);
        let status = resp.status();
        let body = resp.bytes().expect("read body");
        assert!(
            status.is_success(),
            "{method} failed with {status}: {}",
            String::from_utf8_lossy(&body)
        );
        Resp::decode(body).expect("decode response")
    }

    fn raw(&self, method: &str, body: Vec<u8>, token: &str) -> reqwest::blocking::Response {
        self.http
            .post(format!("http://127.0.0.1:{}/_anki/{method}", self.inst.port))
            .header("Content-Type", "application/binary")
            .header("Authorization", format!("Bearer {token}"))
            .body(body)
            .send()
            .expect("send request")
    }
}

#[test]
fn opens_a_collection_and_lists_decks() {
    let dir = tempfile::tempdir().expect("tempdir");
    let col = dir.path().join("collection.anki2");
    let client = Client::start();

    // Creates the collection file if it does not exist.
    let _: anki_proto::generic::Empty = client.call(
        "openCollection",
        OpenCollectionRequest {
            collection_path: col.to_str().unwrap().to_string(),
            media_folder_path: dir.path().join("media").to_str().unwrap().to_string(),
            media_db_path: dir.path().join("media.db").to_str().unwrap().to_string(),
        },
    );
    assert!(col.exists(), "rslib did not create the collection file");

    // A fresh collection always has the Default deck.
    let decks: DeckNames = client.call(
        "getDeckNames",
        GetDeckNamesRequest {
            skip_empty_default: false,
            include_filtered: true,
        },
    );
    let names: Vec<&str> = decks.entries.iter().map(|e| e.name.as_str()).collect();
    assert!(
        names.iter().any(|n| *n == "Default"),
        "expected a Default deck, got {names:?}"
    );

    let _: anki_proto::generic::Empty = client.call(
        "closeCollection",
        anki_proto::collection::CloseCollectionRequest {
            downgrade_to_schema11: false,
        },
    );
}

#[test]
fn rejects_requests_without_the_token() {
    let client = Client::start();
    let resp = client.raw("getDeckNames", vec![], "wrong-token");
    assert_eq!(
        resp.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "loopback port must not be usable by other apps on the device"
    );
}

#[test]
fn unknown_methods_are_not_found() {
    let client = Client::start();
    let resp = client.raw("noSuchMethod", vec![], &client.inst.token);
    assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);
}

#[test]
fn the_methods_v1_needs_are_routable() {
    // Deliberately spelled as the UI will call them.
    for name in [
        "openCollection",
        "closeCollection",
        "getDeckNames",
        "importAnkiPackage",
        "syncCollection",
        "syncLogin",
        "getQueuedCards",
        "answerCard",
        "renderExistingCard",
        "extractAvTags",
        "getUndoStatus",
        "undo",
    ] {
        assert!(routes::lookup(name).is_some(), "{name} is not routable");
    }
}

/// rslib reads its build hash from vendor/anki/out/buildhash, which only
/// Anki's Ninja build writes. We build with plain cargo, so an empty hash here
/// means tools/write-buildhash.sh was not run and we cannot tell which Anki is
/// linked in.
#[test]
fn health_reports_which_anki_is_linked() {
    let client = Client::start();
    let body = reqwest::blocking::Client::new()
        .get(format!("http://127.0.0.1:{}/_anki/healthz", client.inst.port))
        .header("Authorization", format!("Bearer {}", client.inst.token))
        .send()
        .expect("healthz")
        .text()
        .expect("body");

    assert!(body.contains(r#""ok":true"#), "unexpected body: {body}");
    assert!(
        !body.contains(r#""anki":"""#),
        "anki build hash is empty - run tools/write-buildhash.sh before cargo build: {body}"
    );
}

/// The web UI is served from the backend's own origin so the webview needs no
/// CORS handling. Assets stay unauthenticated on purpose — they are inert and
/// ship inside the app — which is exactly why the token must never be baked
/// into them.
#[test]
fn serves_the_web_ui_from_the_same_origin() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("index.html"), "<!doctype html><title>MemoryAnchor</title>")
        .expect("write index");
    std::fs::write(dir.path().join("app.js"), "export const x = 1;").expect("write asset");

    let inst = Instance::start(
        &["en".to_string()],
        0,
        false,
        Some(dir.path().to_path_buf()),
    )
    .expect("start backend");
    let http = reqwest::blocking::Client::new();
    let base = format!("http://127.0.0.1:{}", inst.port);

    let index = http.get(&base).send().expect("GET /");
    assert!(index.status().is_success(), "index status {}", index.status());
    assert!(index.text().expect("body").contains("MemoryAnchor"));

    let asset = http.get(format!("{base}/app.js")).send().expect("GET asset");
    assert!(asset.status().is_success());

    // Unknown paths fall back to index.html so client-side routing works.
    let deep = http.get(format!("{base}/decks/42")).send().expect("GET route");
    assert!(deep.status().is_success(), "SPA fallback status {}", deep.status());

    // Serving assets must not have opened up the API.
    let api = http
        .post(format!("{base}/_anki/getDeckNames"))
        .send()
        .expect("POST api");
    assert_eq!(
        api.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "static serving must not bypass API auth"
    );
}

/// rslib's importAnkiPackage takes a path on disk, not bytes, so the webview
/// needs somewhere to put a file the user picked. This covers that hand-off:
/// upload returns a path, and rslib can then import from it.
#[test]
fn uploads_a_package_and_imports_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let inst = Instance::start(&["en".to_string()], 0, false, None).expect("start backend");
    let http = reqwest::blocking::Client::new();
    let base = format!("http://127.0.0.1:{}", inst.port);

    let open = |path: &std::path::Path| {
        let req = anki_proto::collection::OpenCollectionRequest {
            collection_path: path.to_str().unwrap().to_string(),
            media_folder_path: dir.path().join("media").to_str().unwrap().to_string(),
            media_db_path: dir.path().join("media.db").to_str().unwrap().to_string(),
        };
        let resp = http
            .post(format!("{base}/_anki/openCollection"))
            .header("Authorization", format!("Bearer {}", inst.token))
            .body(req.encode_to_vec())
            .send()
            .expect("openCollection");
        assert!(resp.status().is_success(), "openCollection: {}", resp.status());
    };

    // Build a genuine .apkg by exporting one from rslib, rather than crafting
    // a fixture by hand — this way the test exercises the real format.
    let source = dir.path().join("source.anki2");
    open(&source);
    let apkg = dir.path().join("deck.apkg");
    let export = anki_proto::import_export::ExportAnkiPackageRequest {
        out_path: apkg.to_str().unwrap().to_string(),
        limit: None,
        options: Some(anki_proto::import_export::ExportAnkiPackageOptions {
            with_scheduling: false,
            with_deck_configs: false,
            with_media: false,
            legacy: false,
        }),
    };
    let resp = http
        .post(format!("{base}/_anki/exportAnkiPackage"))
        .header("Authorization", format!("Bearer {}", inst.token))
        .body(export.encode_to_vec())
        .send()
        .expect("exportAnkiPackage");
    assert!(resp.status().is_success(), "export: {}", resp.status());
    assert!(apkg.exists(), "no .apkg was written");

    // A backend holds one collection at a time, so release the source before
    // opening the destination.
    let close = http
        .post(format!("{base}/_anki/closeCollection"))
        .header("Authorization", format!("Bearer {}", inst.token))
        .body(
            anki_proto::collection::CloseCollectionRequest {
                downgrade_to_schema11: false,
            }
            .encode_to_vec(),
        )
        .send()
        .expect("closeCollection");
    assert!(close.status().is_success(), "close: {}", close.status());

    // Upload it the way the webview will, then import from the returned path.
    let bytes = std::fs::read(&apkg).expect("read apkg");
    let uploaded = http
        .post(format!("{base}/_anchor/upload"))
        .header("Authorization", format!("Bearer {}", inst.token))
        .header("x-anchor-filename", "deck.apkg")
        .body(bytes)
        .send()
        .expect("upload");
    assert!(uploaded.status().is_success(), "upload: {}", uploaded.status());

    let json: serde_json::Value = uploaded.json().expect("upload json");
    let stored = json["path"].as_str().expect("path in response").to_string();
    assert!(
        std::path::Path::new(&stored).exists(),
        "upload reported a path that does not exist: {stored}"
    );
    assert!(stored.ends_with(".apkg"), "extension not preserved: {stored}");

    let target = dir.path().join("target.anki2");
    open(&target);
    let import = anki_proto::import_export::ImportAnkiPackageRequest {
        package_path: stored,
        options: Some(anki_proto::import_export::ImportAnkiPackageOptions {
            merge_notetypes: false,
            update_notes: 0,
            update_notetypes: 0,
            with_scheduling: false,
            with_deck_configs: false,
        }),
    };
    let resp = http
        .post(format!("{base}/_anki/importAnkiPackage"))
        .header("Authorization", format!("Bearer {}", inst.token))
        .body(import.encode_to_vec())
        .send()
        .expect("importAnkiPackage");
    assert!(
        resp.status().is_success(),
        "import failed: {} {}",
        resp.status(),
        resp.text().unwrap_or_default()
    );
}

#[test]
fn upload_requires_the_token() {
    let inst = Instance::start(&["en".to_string()], 0, false, None).expect("start backend");
    let resp = reqwest::blocking::Client::new()
        .post(format!("http://127.0.0.1:{}/_anchor/upload", inst.port))
        .body(vec![1, 2, 3])
        .send()
        .expect("send");
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

/// Cards reference media by bare filename, so the reviewer needs those served.
/// Anki media names are flat; anything with a path component is refused rather
/// than normalised.
#[test]
fn serves_collection_media_and_refuses_traversal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let media = dir.path().join("collection.media");
    std::fs::create_dir_all(&media).expect("create media dir");
    std::fs::write(media.join("diagram.png"), b"not-really-a-png").expect("write media");
    // A file the media route must never reach.
    std::fs::write(dir.path().join("secret.txt"), b"private").expect("write secret");

    let inst = Instance::start(&["en".to_string()], 0, false, None).expect("start backend");
    let http = reqwest::blocking::Client::new();
    let base = format!("http://127.0.0.1:{}", inst.port);
    let auth = format!("Bearer {}", inst.token);

    let set = http
        .post(format!("{base}/_anchor/paths"))
        .header("Authorization", &auth)
        .body(
            serde_json::json!({
                "mediaRoot": media.to_string_lossy(),
                "dataDir": dir.path().to_string_lossy(),
            })
            .to_string(),
        )
        .send()
        .expect("set paths");
    assert!(set.status().is_success(), "paths: {}", set.status());

    let media_token: String = {
        let health: serde_json::Value = http
            .get(format!("{base}/_anki/healthz"))
            .header("Authorization", &auth)
            .send()
            .expect("healthz")
            .json()
            .expect("health json");
        health["mediaToken"].as_str().expect("mediaToken").to_string()
    };
    assert_ne!(media_token, inst.token, "media must use a separate credential");

    let hit = http
        .get(format!("{base}/_anchor/media/{media_token}/diagram.png"))
        .send()
        .expect("get media");
    assert_eq!(
        hit.headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("*"),
        "fonts in a sandboxed iframe need CORS"
    );
    assert!(hit.status().is_success(), "media: {}", hit.status());
    assert_eq!(hit.bytes().expect("body").as_ref(), b"not-really-a-png");

    for escape in ["../secret.txt", "..%2Fsecret.txt", "sub/dir.png"] {
        let resp = http
            .get(format!("{base}/_anchor/media/{media_token}/{escape}"))
            .send()
            .expect("traversal attempt");
        assert!(
            !resp.status().is_success(),
            "media route served {escape} with {}",
            resp.status()
        );
    }

    let wrong = http
        .get(format!("{base}/_anchor/media/not-the-token/diagram.png"))
        .send()
        .expect("wrong token");
    assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);

    // The API token must not open the media route, nor the reverse.
    let crossed = http
        .get(format!("{base}/_anchor/media/{}/diagram.png", inst.token))
        .send()
        .expect("api token on media route");
    assert_eq!(crossed.status(), reqwest::StatusCode::UNAUTHORIZED);
}

/// The sync key has to survive a restart, and it cannot live in the webview:
/// the loopback port is ephemeral, so the page's origin — and with it any
/// browser storage — changes on every launch.
#[test]
fn prefs_persist_and_require_configured_paths() {
    let dir = tempfile::tempdir().expect("tempdir");
    let inst = Instance::start(&["en".to_string()], 0, false, None).expect("start backend");
    let http = reqwest::blocking::Client::new();
    let base = format!("http://127.0.0.1:{}", inst.port);
    let auth = format!("Bearer {}", inst.token);

    // Before paths are known there is nowhere to put them.
    let early = http
        .put(format!("{base}/_anchor/prefs"))
        .header("Authorization", &auth)
        .body(r#"{"a":1}"#)
        .send()
        .expect("early put");
    assert_eq!(early.status(), reqwest::StatusCode::CONFLICT);

    let set = http
        .post(format!("{base}/_anchor/paths"))
        .header("Authorization", &auth)
        .body(
            serde_json::json!({
                "mediaRoot": dir.path().join("media").to_string_lossy(),
                "dataDir": dir.path().to_string_lossy(),
            })
            .to_string(),
        )
        .send()
        .expect("set paths");
    assert!(set.status().is_success());

    // Nothing stored yet reads as an empty object, not an error.
    let empty: serde_json::Value = http
        .get(format!("{base}/_anchor/prefs"))
        .header("Authorization", &auth)
        .send()
        .expect("get prefs")
        .json()
        .expect("json");
    assert_eq!(empty, serde_json::json!({}));

    let stored = serde_json::json!({ "syncAuth": { "hkey": "secret", "endpoint": null } });
    let put = http
        .put(format!("{base}/_anchor/prefs"))
        .header("Authorization", &auth)
        .body(stored.to_string())
        .send()
        .expect("put prefs");
    assert!(put.status().is_success(), "put: {}", put.status());

    let read: serde_json::Value = http
        .get(format!("{base}/_anchor/prefs"))
        .header("Authorization", &auth)
        .send()
        .expect("get prefs")
        .json()
        .expect("json");
    assert_eq!(read, stored, "prefs did not round-trip");

    assert!(
        dir.path().join("prefs.json").exists(),
        "prefs were not written beside the collection"
    );

    let unauthenticated = http
        .get(format!("{base}/_anchor/prefs"))
        .send()
        .expect("no token");
    assert_eq!(unauthenticated.status(), reqwest::StatusCode::UNAUTHORIZED);
}
