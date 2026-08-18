// File-system operations exposed to the frontend. Mirrors the behaviour of the
// original FileNode / FileBrowser: lazy directory listing (folders first, then
// case-insensitive name order, dotfiles hidden), text read/write, create,
// rename, move-to-trash, and reveal-in-file-manager.

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

// --- LingCode Cloud backend wiring -----------------------------------------

/// Lexical path standardization — the port of `-[NSString
/// stringByStandardizingPath]` that the Mac key (EditorWindowController
/// cloudProjectKeyForRoot:) runs before hashing: collapse `.` and `..`, squeeze
/// repeated separators, drop a trailing separator.
///
/// Deliberately lexical. `std::fs::canonicalize` would resolve symlinks and add
/// a `\\?\` prefix on Windows; Mac's standardization leaves symlinks intact
/// (`/tmp` stays `/tmp`, not `/private/tmp`), so resolving here would put the two
/// platforms further apart, not closer.
///
/// The Windows-only extra: the SAME folder reaches us spelled two ways — the
/// Open Folder… dialog yields `D:\a\b`, while paths we build ourselves (New
/// Quinny Project…) and anything echoed back from `list_dir` use `D:/a/b`. macOS
/// has no such split. We fold to the native backslash form because that is what
/// the dialog — and therefore every key already written to a `.mcp.json` —
/// produces, so existing backends keep resolving.
fn standardize_path(input: &str) -> String {
    #[cfg(windows)]
    let (sep, raw) = ('\\', input.replace('/', "\\"));
    #[cfg(not(windows))]
    let (sep, raw) = ('/', input.to_string());

    let is_sep = |c: char| c == '/' || c == '\\';
    // Keep any leading separator run (POSIX root, or a UNC `\\server\share`).
    let lead: String = raw.chars().take_while(|c| is_sep(*c)).map(|_| sep).collect();
    let mut parts: Vec<&str> = Vec::new();
    for seg in raw.split(is_sep) {
        match seg {
            "" | "." => {}
            ".." => {
                // Only pop a real segment; `..` above the root has nowhere to go,
                // and popping a drive letter would change which volume we mean.
                match parts.last() {
                    Some(last) if *last != ".." && !last.ends_with(':') => { parts.pop(); }
                    _ => parts.push(".."),
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join(&sep.to_string());
    if joined.is_empty() { lead.clone() } else { format!("{lead}{joined}") }
}

/// Stable per-workspace project key, IDENTICAL to the Mac app + full app
/// (LingCodeCloudMCPSetup.projectKey) so the same folder resolves the same
/// managed backend everywhere: "proj_" + first 20 chars of lowercase-hex
/// SHA256(standardized path).
///
/// Stability is load-bearing, not cosmetic: the server stores a backend as
/// `(user_id, project_key)` and looks it up with `getAccountBackend(db, userId,
/// projectKey)` (cloud-backend.js). A key that changes spelling doesn't fail
/// loudly — it misses the lookup, so the agent provisions a SECOND empty backend
/// and the populated one becomes unreachable for that folder.
pub fn cloud_project_key(cwd: &str) -> String {
    let path = standardize_path(cwd);
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    let hex: String = hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    format!("proj_{}", &hex[..20])
}

#[cfg(test)]
mod project_key_tests {
    use super::cloud_project_key;

    /// Every spelling of one folder must hash to one key. Before this, the
    /// dialog form and the built form disagreed and the `x-lingcode-project`
    /// header flip-flopped between two backends.
    #[test]
    fn spellings_of_the_same_folder_agree() {
        let canonical = cloud_project_key(r"D:\Desktop\projects\antisocial");
        for spelling in [
            r"D:/Desktop/projects/antisocial",
            r"D:\Desktop\projects\antisocial\",
            r"D:\Desktop\projects\.\antisocial",
            r"D:\Desktop\projects\clientProject\..\antisocial",
            r"D:\Desktop\\projects\antisocial",
        ] {
            assert_eq!(cloud_project_key(spelling), canonical, "{spelling}");
        }
    }

    /// …and genuinely different folders must still differ.
    #[test]
    fn different_folders_differ() {
        assert_ne!(
            cloud_project_key(r"D:\projects\a"),
            cloud_project_key(r"D:\projects\b"),
        );
    }

    /// The key already written to disk before the fix must keep resolving, or
    /// existing backends would be orphaned by the upgrade.
    #[test]
    fn preserves_the_key_already_on_disk() {
        assert_eq!(
            cloud_project_key(r"D:\Desktop\projects\clientProject\antisocial"),
            "proj_463c7e579c533f7884d3",
        );
    }
}

/// Wire the LingCode Cloud managed backend into `<cwd>/.mcp.json` so the
/// embedded `claude` CLI can provision + use a Postgres/auth/storage/functions
/// backend via the `lingcode-cloud` MCP tools. Uses the CLI's native remote-HTTP
/// MCP transport pointed straight at the account endpoint — no bundled runtime
/// or proxy. The caller passes a token only when signed in; the token is NOT
/// written to disk — the header references `${LINGCODE_CLOUD_TOKEN}`, which the
/// CLI expands from the environment the agent is spawned with. Additive +
/// idempotent: merges into any existing `.mcp.json` without clobbering other
/// servers.
///
/// Returns true when the entry was NEWLY added, so the caller can post the
/// one-time "backend connected" note. Reopening an already-wired folder returns
/// false and stays quiet — same rule as the Mac `wasWired` flag.
pub fn scaffold_cloud_backend(cwd: &str) -> bool {
    let mcp_url = format!("{}/api/cloud/account/mcp", crate::deploy::deploy_api_base());
    let entry = json!({
        "type": "http",
        "url": mcp_url,
        "headers": {
            "Authorization": "Bearer ${LINGCODE_CLOUD_TOKEN}",
            "x-lingcode-project": cloud_project_key(cwd),
        }
    });

    let path = Path::new(cwd).join(".mcp.json");
    let mut root: Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    // Safe: root is guaranteed an object here.
    let obj = match root.as_object_mut() {
        Some(o) => o,
        None => return false,
    };
    let servers = obj.entry("mcpServers").or_insert_with(|| json!({}));
    // Refresh the entry every time: the project key is folder-derived so it's
    // stable, but rewriting keeps it correct if the file was hand-edited.
    let newly_wired = match servers.as_object_mut() {
        Some(map) => map.insert("lingcode-cloud".to_string(), entry).is_none(),
        None => return false, // pre-existing mcpServers is malformed; leave it alone
    };
    match serde_json::to_vec_pretty(&root) {
        Ok(bytes) => std::fs::write(&path, bytes).is_ok() && newly_wired,
        Err(_) => false,
    }
}

/// Folder-open hook: wire the backend for a signed-in user and report whether
/// this was the first time, so the chat can post the one-time note. Silent no-op
/// when signed out. Mirrors the Mac scaffoldCloudBackend: call in openFolderURL:.
#[tauri::command]
pub fn cloud_autoconnect_backend(folder: String) -> bool {
    if crate::deploy::deploy_get_saved_token().is_none() {
        return false; // signed out → nothing to wire
    }
    if folder.trim().is_empty() || !Path::new(&folder).is_dir() {
        return false;
    }
    scaffold_cloud_backend(&folder)
}

/// Best-effort eager provision, so the backend exists — and shows in the web
/// console — the moment a project connects, rather than only on first agent use.
/// Port of LingCodeCloudMCPSetup.provisionEagerly (the full LingCode IDE).
///
/// Writing `.mcp.json` alone grants ACCESS but creates nothing; the console then
/// reads "No backends yet", which is indistinguishable from a broken connect.
/// The call is idempotent server-side (`provisionBackend` returns the existing
/// row when one is already live), so reconnecting never double-creates.
///
/// The label is the folder name, so the console isn't a wall of opaque hashes.
/// We do NOT send `project_id`: that comes from the IDE's ProjectManifestStore,
/// which Baby has no equivalent of — the server falls back to project_key, which
/// is exactly the pre-existing behaviour for a solo project.
async fn provision_backend_eagerly(folder: &str, token: &str) -> Result<(), String> {
    let url = format!(
        "{}/api/cloud/account/backends/provision",
        crate::deploy::deploy_api_base()
    );
    let label = Path::new(folder)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let body = json!({ "project_key": cloud_project_key(folder), "label": label });

    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach LingCode Cloud: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // Surface the server's own error code — `cloud_not_configured`,
        // `unauthorized`, `too_many_inflight` each need a different user action.
        let code = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("provision-failed: {} ({code})", status.as_u16()));
    }
    Ok(())
}

/// Explicit, discoverable counterpart to the silent auto-wiring that runs on
/// every `claude_send` when signed in: writes the `lingcode-cloud` MCP entry AND
/// eagerly creates the backend, so it appears in the console immediately.
///
/// Mirrors EditorWindowController.connectBackendToFolder: for the wiring, plus
/// LingCodeCloudMCPSetup's eager provision for the creation — Baby has no
/// "attach to an existing shared backend" mode, so unlike the IDE there is no
/// case where the eager call would relabel someone else's backend.
///
/// The failure strings are matched by the frontend; keep them in sync with cloud.ts.
#[tauri::command]
pub async fn cloud_connect_backend(folder: String) -> Result<(), String> {
    let token = match crate::deploy::deploy_get_saved_token() {
        Some(t) => t,
        None => return Err("not-signed-in".into()),
    };
    if folder.trim().is_empty() || !Path::new(&folder).is_dir() {
        return Err("no-folder".into());
    }
    scaffold_cloud_backend(&folder);
    provision_backend_eagerly(&folder, &token).await
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

fn to_string(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = Vec::new();
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    for item in rd.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // hide dotfiles, matching the macOS app
        }
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(DirEntry {
            name,
            path: to_string(&item.path()),
            is_dir,
        });
    }
    // Folders first, then case-insensitive name comparison.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    // Reject binary / non-UTF8 files, like the original open path did.
    String::from_utf8(bytes).map_err(|_| "Not a UTF-8 text file".to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_file(parent: String, name: String) -> Result<String, String> {
    let target = PathBuf::from(&parent).join(&name);
    if target.exists() {
        return Err(format!("\"{}\" already exists.", name));
    }
    std::fs::write(&target, b"").map_err(|e| e.to_string())?;
    Ok(to_string(&target))
}

#[tauri::command]
pub fn create_dir(parent: String, name: String) -> Result<String, String> {
    let target = PathBuf::from(&parent).join(&name);
    if target.exists() {
        return Err(format!("\"{}\" already exists.", name));
    }
    std::fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(to_string(&target))
}

#[tauri::command]
pub fn rename_path(from: String, to_name: String) -> Result<String, String> {
    let src = PathBuf::from(&from);
    let parent = src.parent().ok_or("No parent directory")?;
    let dst = parent.join(&to_name);
    if dst.exists() {
        return Err(format!("\"{}\" already exists.", to_name));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(to_string(&dst))
}

#[tauri::command]
pub fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Locate a `node` executable on PATH (used by the screenshot bridge config).
fn find_node() -> String {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(exe);
            if p.is_file() {
                return p.to_string_lossy().replace('\\', "/");
            }
        }
    }
    "node".to_string()
}

/// Scaffold the embedded-agent screenshot/visual-regression support files for a
/// freshly opened folder. Mirrors EditorWindowController.scaffoldAgentSupportFiles:
/// writes are additive and idempotent. Returns a note describing what was added,
/// or None when nothing was written (e.g. the screenshot bridge isn't installed,
/// which is the case anywhere LingCode itself isn't — so this is a clean no-op).
#[tauri::command]
pub fn scaffold_agent_files(folder: String) -> Option<String> {
    let home = dirs::home_dir()?;
    let server = home.join(".lingcode/agent-bridge/screenshot-mcp.mjs");
    if !server.is_file() {
        return None; // bridge not installed — don't write configs that point nowhere
    }
    let server_str = server.to_string_lossy().replace('\\', "/");
    let node = find_node();
    let root = PathBuf::from(&folder);
    let mut wrote: Vec<String> = Vec::new();

    // --- .mcp.json (merge, never clobber) ---
    let mcp_path = root.join(".mcp.json");
    let mut mcp: Value = std::fs::read(&mcp_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}));
    if !mcp.is_object() {
        mcp = json!({});
    }
    let servers = mcp
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if servers.is_object() && servers.get("lingcode-screenshot").is_none() {
        servers["lingcode-screenshot"] = json!({
            "type": "stdio",
            "command": node,
            "args": [server_str],
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&mcp) {
            if std::fs::write(&mcp_path, bytes).is_ok() {
                wrote.push(".mcp.json".into());
            }
        }
    }

    // --- test/visual/config.json (create if absent) ---
    let visual_dir = root.join("test").join("visual");
    let cfg_path = visual_dir.join("config.json");
    if !cfg_path.exists() {
        let _ = std::fs::create_dir_all(&visual_dir);
        let app_name = root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "App".into());
        let cfg = json!({
            "app": app_name,
            "threshold": 12,
            "maxDiffRatio": 0.01,
            "cases": [ { "name": "main", "title": "" } ],
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&cfg) {
            if std::fs::write(&cfg_path, bytes).is_ok() {
                wrote.push("test/visual/config.json".into());
            }
        }
    }

    // --- Makefile targets (append if a Makefile exists and lacks them) ---
    let make_path = root.join("Makefile");
    let makefile = std::fs::read_to_string(&make_path).ok();
    if let Some(existing) = &makefile {
        if !existing.contains("test-visual") {
            let block = format!(
                "\n# --- LingCodeBaby visual regression (auto-added) ---\n\
                 # Capture the running app window and diff against test/visual/baselines/.\n\
                 # The app must be running first. Record baselines with test-visual-update.\n\
                 LCM_NODE   = {node}\n\
                 LCM_VISUAL = $(HOME)/.lingcode/agent-bridge/visual-regression.mjs\n\
                 \n\
                 test-visual:\n\
                 \t$(LCM_NODE) $(LCM_VISUAL) --project .\n\
                 \n\
                 test-visual-update:\n\
                 \t$(LCM_NODE) $(LCM_VISUAL) --project . --update\n\
                 \n\
                 .PHONY: test-visual test-visual-update\n"
            );
            if std::fs::write(&make_path, format!("{existing}{block}")).is_ok() {
                wrote.push("Makefile (test-visual targets)".into());
            }
        }
    }

    if wrote.is_empty() {
        return None;
    }
    let list = wrote.join(", ");
    let howto = if makefile.is_some() {
        " Run the app, then `make test-visual-update` to record baselines and `make test-visual` to check for changes."
    } else {
        " The embedded agent can now capture and diff this app's window via the screenshot tools."
    };
    Some(format!("Added visual-testing setup: {list}.{howto}"))
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    #[cfg(target_os = "windows")]
    {
        // /select, highlights the item in Explorer.
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(p.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if p.is_dir() { p.clone() } else { p.parent().map(|x| x.to_path_buf()).unwrap_or(p.clone()) };
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
