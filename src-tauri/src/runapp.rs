//! "Run app" for projects that are not a web page.
//!
//! The Simple layout's Run app used to do one thing: load `<folder>/index.html`
//! into the Preview iframe. A Windows program, a TouchDesigner patch or a
//! Python script therefore showed "No index.html in this folder yet" forever,
//! even while the app was running. This works out what the project's app is
//! and starts it in its own window; the Preview tab then reports whether it is
//! running instead of pretending to show it.
//!
//! Order (first match wins):
//!   1. `.lingcode/run.json` — `{ "command": "...", "label": "..." }`, written by
//!      the agent or the user; anything goes, so it is the escape hatch.
//!   2. `index.html` at the root — a web page, shown in the Preview as before.
//!   3. `package.json` with a `dev` or `start` script.
//!   4. one built `.exe` (root, dist, build, bin\Release, …; newest wins).
//!   5. a TouchDesigner `.toe` — opened with its default app.
//!   6. `main.py` / `app.py`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunTarget {
    /// "web" (Preview iframe), "command" (a shell command), "open" (a file opened
    /// with its default app — an .exe or a document).
    pub kind: String,
    /// What the user sees: "AURA_V1.exe", "TouchDesigner (AURA.toe)", "npm run dev".
    pub label: String,
    /// "Web app", "Windows app", "TouchDesigner", "Node app", "Python app", "Project".
    pub badge: String,
    pub command: Option<String>,
    pub path: Option<String>,
}

#[derive(Deserialize)]
struct RunConfig {
    command: String,
    label: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    /// None when the target can't be checked (a command, a document).
    pub running: Option<bool>,
}

const EXE_DIRS: &[&str] = &["", "dist", "build", "out", "release", "bin/Release", "bin/Debug", "target/release"];

fn is_installer(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["setup", "install", "uninst", "updater", "unins000", "vc_redist", "crashpad", "notification_helper"]
        .iter()
        .any(|w| n.contains(w))
}

fn files_with_ext(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    rd.filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().map_or(false, |x| x.eq_ignore_ascii_case(ext)))
        .collect()
}

fn newest(mut paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    paths.pop()
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// What Run app would start in `folder`, or None when there is nothing yet.
pub fn find_target(folder: &Path) -> Option<RunTarget> {
    if let Ok(text) = std::fs::read_to_string(folder.join(".lingcode").join("run.json")) {
        if let Ok(cfg) = serde_json::from_str::<RunConfig>(&text) {
            let command = cfg.command.trim().to_string();
            if !command.is_empty() {
                let label = cfg.label.filter(|l| !l.trim().is_empty()).unwrap_or_else(|| command.clone());
                return Some(RunTarget { kind: "command".into(), label, badge: "Project".into(), command: Some(command), path: None });
            }
        }
    }
    let index = folder.join("index.html");
    if index.is_file() {
        return Some(RunTarget {
            kind: "web".into(), label: "index.html".into(), badge: "Web app".into(),
            command: None, path: Some(index.to_string_lossy().to_string()),
        });
    }
    if let Ok(text) = std::fs::read_to_string(folder.join("package.json")) {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text) {
            for script in ["dev", "start"] {
                if pkg.get("scripts").and_then(|s| s.get(script)).is_some() {
                    let command = format!("npm run {script}");
                    return Some(RunTarget { kind: "command".into(), label: command.clone(), badge: "Node app".into(), command: Some(command), path: None });
                }
            }
        }
    }
    let exes: Vec<PathBuf> = EXE_DIRS
        .iter()
        .flat_map(|d| files_with_ext(&folder.join(d), "exe"))
        .filter(|p| !is_installer(&file_name(p)))
        .collect();
    if let Some(exe) = newest(exes) {
        return Some(RunTarget {
            kind: "open".into(), label: file_name(&exe), badge: "Windows app".into(),
            command: None, path: Some(exe.to_string_lossy().to_string()),
        });
    }
    if let Some(toe) = newest(files_with_ext(folder, "toe")) {
        return Some(RunTarget {
            kind: "open".into(), label: format!("TouchDesigner ({})", file_name(&toe)), badge: "TouchDesigner".into(),
            command: None, path: Some(toe.to_string_lossy().to_string()),
        });
    }
    for script in ["main.py", "app.py"] {
        if folder.join(script).is_file() {
            let command = format!("python {script}");
            return Some(RunTarget { kind: "command".into(), label: command.clone(), badge: "Python app".into(), command: Some(command), path: None });
        }
    }
    None
}

#[tauri::command]
pub fn run_target(folder: String) -> Option<RunTarget> {
    find_target(Path::new(&folder))
}

/// Start the project's app in its own window. Never waits for it.
#[tauri::command]
pub fn run_start(folder: String) -> Result<RunTarget, String> {
    let dir = PathBuf::from(&folder);
    let target = find_target(&dir).ok_or_else(|| "Nothing to run in this folder yet.".to_string())?;
    match target.kind.as_str() {
        "web" => {}
        "open" => open_detached(&dir, target.path.as_deref().unwrap_or_default())?,
        _ => run_in_console(&dir, &target.label, target.command.as_deref().unwrap_or_default())?,
    }
    Ok(target)
}

/// Whether a Windows app target is running right now (by its image name).
#[tauri::command]
pub fn run_status(folder: String) -> RunStatus {
    let Some(target) = find_target(Path::new(&folder)) else { return RunStatus { running: None } };
    let Some(path) = target.path.filter(|p| p.to_ascii_lowercase().ends_with(".exe")) else {
        return RunStatus { running: None };
    };
    RunStatus { running: image_running(&file_name(Path::new(&path))) }
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW: the `cmd /C start` shim itself stays hidden
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

fn open_detached(dir: &Path, path: &str) -> Result<(), String> {
    if path.is_empty() { return Err("Nothing to open.".into()); }
    #[cfg(windows)]
    let mut cmd = {
        // `start "" "<file>"`: the program in its own process, or the document
        // in its default app (TouchDesigner for .toe). The first quoted arg is
        // the window title `start` requires before a quoted path.
        // raw_arg: cmd.exe does not parse quotes the way Rust escapes args.
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.raw_arg(format!("/C start \"\" \"{}\"", path.replace('"', "")));
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(path);
        c
    };
    no_window(&mut cmd);
    cmd.current_dir(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn run_in_console(dir: &Path, label: &str, command: &str) -> Result<(), String> {
    if command.is_empty() { return Err("No command to run.".into()); }
    #[cfg(windows)]
    let mut cmd = {
        // A visible console that stays open (/K), so the user sees the app's
        // output and errors and can close it to stop the app.
        use std::os::windows::process::CommandExt;
        let title = label.replace('"', "'");
        let mut c = Command::new("cmd");
        c.raw_arg(format!("/C start \"{title}\" cmd /K {command}"));
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let _ = label;
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    no_window(&mut cmd);
    cmd.current_dir(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn image_running(image: &str) -> Option<bool> {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("IMAGENAME eq {image}"), "/NH", "/FO", "CSV"]);
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_ascii_lowercase();
    Some(text.contains(&format!("\"{}\"", image.to_ascii_lowercase())))
}
#[cfg(not(windows))]
fn image_running(image: &str) -> Option<bool> {
    let out = Command::new("pgrep").args(["-x", image.trim_end_matches(".exe")]).output().ok()?;
    Some(out.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("lcb-runapp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
    }

    #[test]
    fn nothing_to_run() {
        let d = tmp();
        touch(&d.join("README.md"));
        assert_eq!(find_target(&d), None);
    }

    #[test]
    fn a_built_exe_in_dist_and_installers_skipped() {
        let d = tmp();
        touch(&d.join("dist/AURA_V1.exe"));
        touch(&d.join("dist/unins000.exe"));
        touch(&d.join("Setup.exe"));
        let t = find_target(&d).unwrap();
        assert_eq!(t.kind, "open");
        assert_eq!(t.label, "AURA_V1.exe");
        assert_eq!(t.badge, "Windows app");
    }

    #[test]
    fn touchdesigner_when_no_exe() {
        let d = tmp();
        touch(&d.join("studio.toe"));
        let t = find_target(&d).unwrap();
        assert_eq!(t.badge, "TouchDesigner");
        assert_eq!(t.label, "TouchDesigner (studio.toe)");
    }

    #[test]
    fn run_json_wins_over_everything() {
        let d = tmp();
        touch(&d.join("index.html"));
        touch(&d.join("dist/App.exe"));
        std::fs::create_dir_all(d.join(".lingcode")).unwrap();
        std::fs::write(d.join(".lingcode/run.json"), r#"{"command":"start AURA.bat","label":"AURA studio"}"#).unwrap();
        let t = find_target(&d).unwrap();
        assert_eq!((t.kind.as_str(), t.label.as_str(), t.command.as_deref()), ("command", "AURA studio", Some("start AURA.bat")));
    }

    #[test]
    fn web_then_node_then_python() {
        let d = tmp();
        touch(&d.join("main.py"));
        assert_eq!(find_target(&d).unwrap().command.as_deref(), Some("python main.py"));
        std::fs::write(d.join("package.json"), r#"{"scripts":{"start":"node server.js"}}"#).unwrap();
        assert_eq!(find_target(&d).unwrap().command.as_deref(), Some("npm run start"));
        touch(&d.join("index.html"));
        assert_eq!(find_target(&d).unwrap().kind, "web");
    }

    #[test]
    fn a_blank_run_json_is_ignored() {
        let d = tmp();
        std::fs::create_dir_all(d.join(".lingcode")).unwrap();
        std::fs::write(d.join(".lingcode/run.json"), r#"{"command":"  "}"#).unwrap();
        touch(&d.join("app.py"));
        assert_eq!(find_target(&d).unwrap().command.as_deref(), Some("python app.py"));
    }
}
