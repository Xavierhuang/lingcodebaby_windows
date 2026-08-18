// Per-project chat transcript + attachment storage under `<project>/.lingcode/`.
// Windows mirror of the history layer in ClaudeChat.m (ensureLingcodeDirForRoot:,
// saveHistory, loadHistoryForRoot:, attachImagePNG:).
//
// WHY A BABY-SPECIFIC FILE: the Mac IDE, LingCodeBaby and LingCodeEngine can all
// have the SAME project folder open. Sharing `.lingcode/chat.json` meant one
// transcript with last-writer-wins, both apps restoring the same session id and
// running `claude --resume <same id>` against one CLI session, and "New
// conversation" in one app deleting the other's transcript. Baby takes its own
// file; the legacy shared one is adopted ONCE (messages only, never the session
// id) so upgrading doesn't look like data loss.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const TRANSCRIPT_FILE: &str = "chat-baby.json";
const LEGACY_SHARED_FILE: &str = "chat.json";

/// `.lingcode` lives INSIDE the user's repo and holds the transcript and every
/// pasted attachment — conversations routinely carry credentials, file contents
/// and error output, so a `git add -A` would commit all of it. Drop the same
/// ignore file the Mac app writes: everything local except project.json, which
/// must stay committable or a collaborator's clone can't resolve the same
/// backend. Written once; never clobbers a user edit.
pub fn ensure_lingcode_dir(root: &str) -> PathBuf {
    let dir = Path::new(root).join(".lingcode");
    let _ = std::fs::create_dir_all(&dir);
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(
            &ignore,
            "# Keep only the project identity in git; everything else here is local.\n\
             *\n!.gitignore\n!project.json\n",
        );
    }
    dir
}

fn transcript_path(root: &str) -> PathBuf {
    ensure_lingcode_dir(root).join(TRANSCRIPT_FILE)
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Load this folder's saved conversation. Returns the stored document
/// (`{session, model, messages}`) or `null` when there is nothing saved.
///
/// Falls back once to the legacy shared `chat.json`, carrying the messages
/// across but deliberately NOT the session id — otherwise this app and the Mac
/// IDE would both `claude --resume` the same session. The first save writes to
/// our own file and the two diverge from there.
#[tauri::command]
pub fn history_load(folder: String) -> Value {
    let read = |p: PathBuf| -> Option<Value> {
        std::fs::read(p)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .filter(Value::is_object)
    };

    if let Some(doc) = read(transcript_path(&folder)) {
        return doc;
    }
    match read(ensure_lingcode_dir(&folder).join(LEGACY_SHARED_FILE)) {
        Some(mut doc) => {
            if let Some(obj) = doc.as_object_mut() {
                obj.remove("session");
                obj.remove("sessions");
                obj.insert("adopted_legacy".into(), json!(true));
            }
            doc
        }
        None => Value::Null,
    }
}

/// Persist the display transcript plus the opaque CLI session id for `--resume`.
#[tauri::command]
pub fn history_save(folder: String, doc: Value) -> Result<(), String> {
    let path = transcript_path(&folder);
    let bytes = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Delete ONLY our saved transcript for this folder. The Mac app used to remove
/// the shared `chat.json` here, which meant starting a new conversation in Baby
/// also wiped the IDE's transcript for the same folder — don't repeat that.
#[tauri::command]
pub fn history_clear(folder: String) -> Result<(), String> {
    let path = transcript_path(&folder);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Decode standard base64 (no whitespace tolerance beyond `\n`/`\r`). Kept local
/// so pasting a screenshot doesn't pull in a crate.
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in input.as_bytes() {
        if c == b'\n' || c == b'\r' || c == b'=' {
            continue;
        }
        let v = val(c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Save a pasted/dropped image under `<project>/.lingcode/attachments/` and
/// return its absolute path. The path (not the bytes) is handed to the agent,
/// which views it with its Read tool — same contract as the Mac app.
#[tauri::command]
pub fn attach_save(folder: String, data_base64: String, ext: String) -> Result<String, String> {
    let bytes = base64_decode(&data_base64).ok_or("Attachment data was not valid base64.")?;
    if bytes.is_empty() {
        return Err("Attachment was empty.".into());
    }
    let dir = ensure_lingcode_dir(&folder).join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Disambiguate repeated pastes within the same second.
    let ext = ext.trim_start_matches('.');
    let ext = if ext.is_empty() { "png" } else { ext };
    let stamp = unix_secs();
    let mut path = dir.join(format!("pasted-{stamp}.{ext}"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("pasted-{stamp}-{n}.{ext}"));
        n += 1;
    }
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().replace('\\', "/"))
}

/// Drop a queued attachment: removes the chip's backing file. Best-effort — a
/// missing file is not an error (the user may have deleted it themselves).
#[tauri::command]
pub fn attach_remove(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
