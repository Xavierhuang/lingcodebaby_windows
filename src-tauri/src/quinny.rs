// Windows mirror of the Mac LingCodeBaby Quinny integration:
//   - LingCodeBaby/src/FileBrowser.m locateQuinnyBinary + runQuinnySubcommand
//     (right-click "Quinny: Check" / "Quinny: Show Plan" on .qn files;
//      "New Quinny File…")
//   - LingCodeBaby/src/EditorWindowController.m LCB_LocateQuinnyBinary +
//     newQuinnyProject: (File → New Quinny Project…, prompts for description
//     and runs `quinny gen "<desc>" -o <folder>/project.qn`)
//   - LingCodeBaby/Makefile line 79-83 which copies vendor/quinny/ into
//     Contents/Resources/quinny/ inside the shipped .app.
//
// Windows equivalent: a PyInstaller-frozen `quinny.exe` + `_internal/` under
// src-tauri/binaries/quinny/, shipped via tauri.conf.json bundle.resources
// into <resource_dir>/binaries/quinny/ at runtime. The binary itself has to be
// produced on a Windows box (scripts/build-quinny-windows.ps1); when it isn't
// present, locate() returns None and Quinny commands surface a friendly
// "not found" error — same failure mode as Mac when vendor/quinny/ is empty.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Native filename of the frozen Quinny binary on this platform.
#[cfg(windows)]
const EXE: &str = "quinny.exe";
#[cfg(not(windows))]
const EXE: &str = "quinny";

/// Bundled dir (`<resource_dir>/binaries/quinny/`) if the frozen binary is
/// actually present. Used both by locate() and by chat.rs to prepend to PATH.
pub fn bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    let dir = res.join("binaries").join("quinny");
    if dir.join(EXE).is_file() { Some(dir) } else { None }
}

/// Locate a Quinny executable. Order matches Mac (FileBrowser.m:493-526):
/// $QUINNY_BIN env override → bundled → PATH walk.
pub fn locate(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(env_bin) = std::env::var("QUINNY_BIN") {
        let p = PathBuf::from(env_bin);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(dir) = bundled_dir(app) {
        return Some(dir.join(EXE));
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(EXE);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Merge LingModel routing env (proxy URL + auth token + model tag) so the
/// bundled Quinny CLI can hit an LLM through the user's LingCode account.
/// No-op when signed out; quinny then surfaces its own "no API key" message.
/// Also strips ANSI color (matches Mac's NO_COLOR/TERM=dumb from
/// FileBrowser.m:557-559) and hides the console window on Windows.
fn apply_lingmodel_env(cmd: &mut std::process::Command) {
    // Endpoint priority mirrors chat.rs: custom endpoint > LingModel >
    // personal Anthropic key from Keychain. `quinny gen`/`build`/`verify` hit
    // the LLM directly (not through `claude`), so quinny needs the same env.
    if crate::endpoint::is_active() {
        let prefs = crate::prefs::get_prefs();
        if let Some(key) = crate::endpoint::get_key() {
            cmd.env("ANTHROPIC_BASE_URL", &prefs.custom_endpoint_url);
            cmd.env("ANTHROPIC_API_KEY", key);
            cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
        }
    } else if let Some(tok) = crate::deploy::deploy_get_saved_token() {
        cmd.env("ANTHROPIC_BASE_URL", crate::deploy::lingmodel_anthropic_base_url());
        cmd.env("ANTHROPIC_AUTH_TOKEN", tok);
        cmd.env("QUINNY_MODEL", crate::chat::LINGMODEL_UPSTREAM);
        cmd.env_remove("ANTHROPIC_API_KEY");
    } else if let Some(key) = crate::anthropic_key::get() {
        // Personal-key fallback (Mac's `LCBAnthropicKey mergeIntoEnvironment`)
        // — lets `quinny gen`/`New Quinny Project…` work when signed out.
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    cmd.env("NO_COLOR", "1");
    cmd.env("TERM", "dumb");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

#[derive(serde::Serialize)]
pub struct QuinnyOutput {
    pub exit_code: i32,
    pub output: String,
}

#[tauri::command]
pub async fn quinny_available(app: AppHandle) -> bool {
    locate(&app).is_some()
}

/// Run `quinny <subcommand> <path>` (typically check / plan / verify) and
/// return combined stdout+stderr for display in a native alert. Mirrors
/// FileBrowser.m runQuinnySubcommand.
#[tauri::command]
pub async fn quinny_run(
    app: AppHandle,
    subcommand: String,
    path: String,
) -> Result<QuinnyOutput, String> {
    let bin = locate(&app).ok_or_else(not_found_msg)?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg(&subcommand).arg(&path);
    apply_lingmodel_env(&mut cmd);
    let out = tokio::task::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("Failed to launch quinny: {e}"))?;
    let mut combined = String::from_utf8_lossy(&out.stdout).to_string();
    combined.push_str(&String::from_utf8_lossy(&out.stderr));
    if combined.trim().is_empty() {
        combined = "(no output)".into();
    }
    Ok(QuinnyOutput {
        exit_code: out.status.code().unwrap_or(-1),
        output: combined,
    })
}

/// Starter template dropped into new `.qn` files. Byte-identical to
/// kQuinnyStarterTemplate in FileBrowser.m:457-464.
const STARTER_TEMPLATE: &str = "project MyProject\n\ntask Example\n    goal\n        Describe what this task achieves in one sentence.\n    success\n        Define what \"done\" looks like.\n";

/// Create `<dir>/<name>` (auto-appending `.qn`) and seed it with the starter
/// template. Mirrors FileBrowser.m newQuinnyFile.
#[tauri::command]
pub async fn quinny_new_file(dir: String, name: String) -> Result<String, String> {
    let mut name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name required.".into());
    }
    if !name.to_lowercase().ends_with(".qn") {
        name.push_str(".qn");
    }
    let path = Path::new(&dir).join(&name);
    if path.exists() {
        return Err(format!("An item named {name} already exists."));
    }
    std::fs::write(&path, STARTER_TEMPLATE).map_err(|e| format!("Write failed: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Create `<folder>` and run `quinny gen "<description>" -o <folder>/project.qn`.
/// Returns the path to the generated .qn on success. Mirrors
/// EditorWindowController.m newQuinnyProject: (the "New Quinny Project…"
/// action).
#[tauri::command]
pub async fn quinny_new_project(
    app: AppHandle,
    folder: String,
    description: String,
) -> Result<String, String> {
    let bin = locate(&app).ok_or_else(not_found_msg)?;
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err("Description required.".into());
    }
    let folder = PathBuf::from(&folder);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not create folder: {e}"))?;
    let qn = folder.join("project.qn");
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("gen")
        .arg(&description)
        .arg("-o")
        .arg(&qn);
    apply_lingmodel_env(&mut cmd);
    let out = tokio::task::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("Failed to launch quinny: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "Quinny CLI exited non-zero. Configure an endpoint via View → Custom Endpoint…, sign in to LingCode, or paste a personal Anthropic key so `quinny gen` can reach an LLM.".into()
        } else {
            err
        });
    }
    Ok(qn.to_string_lossy().into_owned())
}

fn not_found_msg() -> String {
    "Quinny CLI not found. Run scripts/build-quinny-windows.ps1 on a Windows \
     machine to produce the bundled binary, or set $QUINNY_BIN to a `quinny` \
     executable on disk."
        .into()
}
