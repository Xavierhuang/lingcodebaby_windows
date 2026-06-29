// File-system operations exposed to the frontend. Mirrors the behaviour of the
// original FileNode / FileBrowser: lazy directory listing (folders first, then
// case-insensitive name order, dotfiles hidden), text read/write, create,
// rename, move-to-trash, and reveal-in-file-manager.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

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
