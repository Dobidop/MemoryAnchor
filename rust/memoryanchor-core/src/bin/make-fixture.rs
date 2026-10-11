// Builds a small .apkg with real notes, for exercising import and the
// reviewer during development. Not shipped; this is a developer tool.
//
// Usage: cargo run --bin make-fixture -- <output.apkg>

use std::path::PathBuf;

use anki_proto::notes::AddNoteRequest;
use anki_proto::notes::Note;
use anyhow::bail;
use anyhow::Context;
use anyhow::Result;
use memoryanchor_core::Instance;
use prost::Message;

struct Client {
    base: String,
    token: String,
    http: reqwest::blocking::Client,
}

impl Client {
    fn call<Req: Message, Resp: Message + Default>(&self, method: &str, req: Req) -> Result<Resp> {
        let resp = self
            .http
            .post(format!("{}/_anki/{method}", self.base))
            .header("Authorization", format!("Bearer {}", self.token))
            .body(req.encode_to_vec())
            .send()?;
        let status = resp.status();
        let body = resp.bytes()?;
        if !status.is_success() {
            bail!("{method} failed ({status}): {}", String::from_utf8_lossy(&body));
        }
        Ok(Resp::decode(body)?)
    }
}

const CARDS: [(&str, &str); 6] = [
    ("What does rslib provide?", "Anki's scheduling, rendering, import and sync."),
    ("Why embed rslib instead of reimplementing?", "Scheduling stays identical to Anki's."),
    ("How does the webview reach the backend?", "POST /_anki/&lt;method&gt; over loopback."),
    ("Why is the loopback port authenticated?", "Any app on the device can reach it."),
    ("What is FSRS?", "The spaced repetition scheduler Anki uses."),
    ("Where do collections live on iOS?", "Application Support."),
];

fn main() -> Result<()> {
    let out = PathBuf::from(
        std::env::args()
            .nth(1)
            .context("usage: make-fixture <output.apkg>")?,
    );

    let work = std::env::temp_dir().join(format!("anchor-fixture-{}", std::process::id()));
    std::fs::create_dir_all(&work)?;

    let instance = Instance::start(&["en".to_string()], 0, false, None)?;
    let client = Client {
        base: format!("http://127.0.0.1:{}", instance.port),
        token: instance.token.clone(),
        http: reqwest::blocking::Client::new(),
    };

    let _: anki_proto::generic::Empty = client.call(
        "openCollection",
        anki_proto::collection::OpenCollectionRequest {
            collection_path: work.join("fixture.anki2").to_string_lossy().into(),
            media_folder_path: work.join("media").to_string_lossy().into(),
            media_db_path: work.join("media.db").to_string_lossy().into(),
        },
    )?;

    // A fresh collection ships with Anki's stock notetypes; Basic is enough.
    let names: anki_proto::notetypes::NotetypeNames =
        client.call("getNotetypeNames", anki_proto::generic::Empty {})?;
    let basic = names
        .entries
        .iter()
        .find(|n| n.name == "Basic")
        .context("no Basic notetype in a fresh collection")?;

    for (front, back) in CARDS {
        let _: anki_proto::notes::AddNoteResponse = client.call(
            "addNote",
            AddNoteRequest {
                note: Some(Note {
                    id: 0,
                    guid: String::new(),
                    notetype_id: basic.id,
                    mtime_secs: 0,
                    usn: 0,
                    tags: vec!["anchor-fixture".into()],
                    fields: vec![front.to_string(), back.to_string()],
                }),
                deck_id: 1,
            },
        )?;
    }

    let _: anki_proto::generic::UInt32 = client.call(
        "exportAnkiPackage",
        anki_proto::import_export::ExportAnkiPackageRequest {
            out_path: out.to_string_lossy().into(),
            limit: None,
            options: Some(anki_proto::import_export::ExportAnkiPackageOptions {
                with_scheduling: false,
                with_deck_configs: false,
                with_media: false,
                legacy: false,
            }),
        },
    )?;

    let _: anki_proto::generic::Empty = client.call(
        "closeCollection",
        anki_proto::collection::CloseCollectionRequest {
            downgrade_to_schema11: false,
        },
    )?;

    let size = std::fs::metadata(&out)?.len();
    println!("wrote {} ({size} bytes, {} notes)", out.display(), CARDS.len());
    Ok(())
}
