// The Claude Code CLI shipped inside the Windows installer.
//
// The release workflow fetches Anthropic's platform package
// (`@anthropic-ai/claude-agent-sdk-win32-{x64,arm64}`, one `claude.exe`) into
// src-tauri/binaries/claude/ (scripts/fetch-claude-windows.ps1), and
// tauri.conf.json → bundle.resources ships it to <resource_dir>/binaries/claude/.
// chat.rs prefers this copy over anything installed on the machine, so a fresh
// Windows install can chat without downloading Claude Code first. Linux and
// macOS builds ship no such file and keep the host lookup.
//
// Credentials and sessions live in ~/.claude regardless of which binary runs,
// so a user who already ran `claude login` keeps that login under the bundled
// copy, and one who has not can sign in through `claude_login` below.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
pub const EXE: &str = "claude.exe";
#[cfg(not(windows))]
pub const EXE: &str = "claude";

/// The bundled CLI, if this build shipped one.
pub fn bundled_exe(app: &AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    bundled_exe_in(&res)
}

/// Same lookup against an explicit resource dir, so it can be tested without an
/// app handle.
pub fn bundled_exe_in(resource_dir: &Path) -> Option<PathBuf> {
    let p = resource_dir.join("binaries").join("claude").join(EXE);
    p.is_file().then_some(p)
}

/// Open a console running `claude login` with whichever CLI the chat would use.
/// The bundled copy is not on the user's PATH, so "run `claude login` in your
/// terminal" is not something a fresh install can do by itself. Returns a line
/// for the UI to show. Windows only: elsewhere the host CLI is on PATH already.
#[tauri::command]
pub fn claude_login(app: AppHandle) -> Result<String, String> {
    let bin = crate::chat::find_claude_with(bundled_exe(&app))?;
    #[cfg(windows)]
    {
        // `start` gives the interactive login its own console window; the empty
        // quoted argument is the window title `start` insists on when the next
        // argument is quoted.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", bin.to_string_lossy().as_ref(), "login"])
            .spawn()
            .map_err(|e| format!("Could not open a console for claude login: {e}"))?;
        Ok("A console window opened. Finish signing in there, then come back and chat.".into())
    }
    #[cfg(not(windows))]
    {
        Err(format!("Run `{} login` in a terminal, then send again.", bin.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lcb-claude-bin-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_the_shipped_binary_under_the_resource_dir() {
        let res = scratch("present");
        let dir = res.join("binaries").join("claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(EXE), b"MZ").unwrap();
        assert_eq!(bundled_exe_in(&res), Some(dir.join(EXE)));
        let _ = std::fs::remove_dir_all(&res);
    }

    #[test]
    fn a_build_without_the_binary_reports_none() {
        let res = scratch("absent");
        std::fs::create_dir_all(res.join("binaries").join("claude")).unwrap();
        assert_eq!(bundled_exe_in(&res), None);
        let _ = std::fs::remove_dir_all(&res);
    }
}
