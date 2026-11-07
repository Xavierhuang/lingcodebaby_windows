// Codex chat backend: runs the user's own `codex` CLI (signed in with
// ChatGPT) one turn at a time with `codex exec --json`, and translates its
// JSONL events into the same chat events `claude_send` emits, so the chat
// panel renders a Codex turn exactly like a Claude one.
//
// The Mac app drives `codex app-server` instead (LingCodeBaby/src/
// LCBCodexAdapter.m); this app spawns one CLI process per turn, which is what
// `codex exec` is built for. The auth rule is the Mac one: ChatGPT sign-in
// only, never an API key (LCBCodexOnboarding.m), so a turn can't silently bill
// someone's OpenAI credit.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// The picker's model tag for Codex.
pub const TAG: &str = "codex";
/// Codex thread ids are stored with this prefix so a chat never hands a
/// Claude session id to Codex, or a Codex one to Claude.
const SESSION_PREFIX: &str = "codex:";

const NOT_INSTALLED: &str = "Codex isn't installed. Install it with `npm install -g @openai/codex` (LingCodeBaby → Codex → Install Codex… does this for you), then send again.";
const NOT_SIGNED_IN: &str = "Codex isn't signed in. Sign in with your ChatGPT account (LingCodeBaby → Codex → Sign in with ChatGPT…), then send again.";
const API_KEY_MODE: &str = "Codex is set up to bill an OpenAI API key. LingCodeBaby only uses Codex with a ChatGPT sign-in, so it never spends API credit without asking. Run `codex logout`, then sign in with ChatGPT (LingCodeBaby → Codex → Sign in with ChatGPT…).";

#[cfg(target_os = "windows")]
const TRIPLES: [(&str, &str); 2] = [
    ("@openai/codex-win32-x64", "x86_64-pc-windows-msvc"),
    ("@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"),
];
#[cfg(target_os = "macos")]
const TRIPLES: [(&str, &str); 2] = [
    ("@openai/codex-darwin-arm64", "aarch64-apple-darwin"),
    ("@openai/codex-darwin-x64", "x86_64-apple-darwin"),
];
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
const TRIPLES: [(&str, &str); 2] = [
    ("@openai/codex-linux-x64", "x86_64-unknown-linux-musl"),
    ("@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"),
];

const EXE: &str = if cfg!(windows) { "codex.exe" } else { "codex" };

/// Where an npm global install of `@openai/codex` keeps the native binary,
/// under a `node_modules` folder. The `codex.cmd` shim on PATH runs Node,
/// which runs this; we go straight to it, because Windows can't pass our
/// arguments through a .cmd (see chat.rs `resolve_cmd_shim`).
fn npm_native_candidates(node_modules: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for (pkg, triple) in TRIPLES {
        let tail = PathBuf::from("vendor").join(triple).join("bin").join(EXE);
        // Nested under the main package (npm's usual layout), then hoisted.
        out.push(node_modules.join("@openai/codex/node_modules").join(pkg).join(&tail));
        out.push(node_modules.join(pkg).join(&tail));
        // Older releases shipped the binary inside the main package.
        out.push(node_modules.join("@openai/codex").join(&tail));
    }
    out
}

fn is_file(p: &Path) -> bool {
    p.is_file()
}

/// The native `codex` executable, or why there isn't one.
pub(crate) fn find_codex() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    for var in ["APPDATA", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            candidates.extend(npm_native_candidates(&PathBuf::from(&base).join("npm").join("node_modules")));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for root in ["/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules"] {
            candidates.extend(npm_native_candidates(Path::new(root)));
        }
        if let Some(h) = dirs::home_dir() {
            candidates.extend(npm_native_candidates(&h.join(".npm-global/lib/node_modules")));
        }
    }
    if let Some(found) = candidates.into_iter().find(|p| is_file(p)) {
        return Ok(found);
    }
    // A standalone install (GitHub release, winget, Homebrew) puts the real
    // binary on PATH. A bare `codex.cmd` is the npm shim: find its node_modules.
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(EXE);
            if is_file(&p) {
                #[cfg(not(target_os = "windows"))]
                {
                    // On Mac/Linux `codex` on PATH may be the Node launcher
                    // symlink; prefer the native binary beside its package.
                    if let Ok(real) = std::fs::canonicalize(&p) {
                        if let Some(nm) = real.ancestors().find(|a| a.ends_with("node_modules")) {
                            if let Some(found) = npm_native_candidates(nm).into_iter().find(|c| is_file(c)) {
                                return Ok(found);
                            }
                        }
                    }
                }
                return Ok(p);
            }
            #[cfg(target_os = "windows")]
            {
                let shim = dir.join("codex.cmd");
                if shim.is_file() {
                    if let Some(found) = npm_native_candidates(&dir.join("node_modules")).into_iter().find(|c| is_file(c)) {
                        return Ok(found);
                    }
                }
            }
        }
    }
    Err(NOT_INSTALLED.to_string())
}

/// How Codex is signed in, from `codex login status`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Login {
    ChatGpt,
    ApiKey,
    SignedOut,
}

pub(crate) fn parse_login_status(out: &str) -> Login {
    let t = out.to_ascii_lowercase();
    if t.contains("not logged in") {
        Login::SignedOut
    } else if t.contains("chatgpt") {
        Login::ChatGpt
    } else if t.contains("api key") || t.contains("apikey") {
        Login::ApiKey
    } else {
        Login::SignedOut
    }
}

fn hidden(cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(target_os = "windows"))]
    let _ = cmd;
}

async fn login_state(bin: &Path) -> Login {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(["login", "status"]).stdin(Stdio::null());
    hidden(&mut cmd);
    match tokio::process::Command::from(cmd).output().await {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&o.stderr));
            parse_login_status(&s)
        }
        Err(_) => Login::SignedOut,
    }
}

/// For the UI: "ready", "signed_out", "api_key" or "not_installed".
#[tauri::command]
pub async fn codex_status() -> String {
    let Ok(bin) = find_codex() else { return "not_installed".into() };
    match login_state(&bin).await {
        Login::ChatGpt => "ready",
        Login::ApiKey => "api_key",
        Login::SignedOut => "signed_out",
    }
    .into()
}

/// Open a console running `codex login` (ChatGPT sign-in in the browser).
#[tauri::command]
pub fn codex_login() -> Result<String, String> {
    let bin = find_codex()?;
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", bin.to_string_lossy().as_ref(), "login"])
            .spawn()
            .map_err(|e| format!("Could not open a console for codex login: {e}"))?;
        Ok("A console window opened. Sign in with your ChatGPT account there, then come back and chat.".into())
    }
    #[cfg(not(windows))]
    {
        Err(format!("Run `{} login` in a terminal, then send again.", bin.display()))
    }
}

/// Open a console that installs Codex with npm. The menu item's confirm dialog
/// is the consent step; nothing runs before it.
#[tauri::command]
pub fn codex_install() -> Result<String, String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", "npm install -g @openai/codex"])
            .spawn()
            .map_err(|e| format!("Could not open a console: {e}"))?;
        Ok("Installing Codex in a console window. When it finishes, choose Sign in with ChatGPT.".into())
    }
    #[cfg(not(windows))]
    {
        Err("Run `npm install -g @openai/codex` in a terminal.".into())
    }
}

/// Turns Codex `exec --json` events into chat events. One per turn.
#[derive(Default)]
pub(crate) struct Translator {
    /// Items already shown, so a command is listed once whether we see its
    /// `item.started`, its `item.completed`, or both.
    shown: HashSet<String>,
    last_message: String,
    /// The most recent stream error, reported if the turn never finishes.
    pub last_error: Option<String>,
    pub finished: bool,
    pub session: Option<String>,
}

fn clip(s: &str) -> String {
    let mut s = s.replace('\n', " ");
    if s.chars().count() > 100 {
        s = s.chars().take(100).collect::<String>();
        s.push('\u{2026}');
    }
    s
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

impl Translator {
    pub fn events(&mut self, v: &Value) -> Vec<Value> {
        let mut out = Vec::new();
        match str_of(v, "type") {
            "thread.started" => {
                let id = str_of(v, "thread_id");
                if !id.is_empty() {
                    let sid = format!("{SESSION_PREFIX}{id}");
                    self.session = Some(sid.clone());
                    out.push(json!({ "kind": "session", "id": sid }));
                }
            }
            t @ ("item.started" | "item.updated" | "item.completed") => {
                let Some(item) = v.get("item") else { return out };
                let id = str_of(item, "id").to_string();
                let done = t == "item.completed";
                match str_of(item, "type") {
                    "agent_message" if done => {
                        let text = str_of(item, "text");
                        if !text.trim().is_empty() {
                            self.last_message = text.to_string();
                            out.push(json!({ "kind": "text", "text": text }));
                        }
                    }
                    "reasoning" if done => {
                        let text = str_of(item, "text");
                        if !text.trim().is_empty() {
                            out.push(json!({ "kind": "thinking", "text": text }));
                        }
                    }
                    "command_execution" => {
                        if self.shown.insert(id) {
                            out.push(json!({ "kind": "tool", "name": "Shell", "detail": clip(str_of(item, "command")) }));
                        }
                    }
                    "file_change" if done => {
                        if self.shown.insert(id) {
                            for ch in item.get("changes").and_then(|c| c.as_array()).into_iter().flatten() {
                                let name = match str_of(ch, "kind") {
                                    "add" => "Created",
                                    "delete" => "Deleted",
                                    _ => "Edited",
                                };
                                out.push(json!({ "kind": "tool", "name": name, "detail": clip(str_of(ch, "path")) }));
                            }
                        }
                    }
                    "mcp_tool_call" => {
                        if self.shown.insert(id) {
                            let name = format!("{}.{}", str_of(item, "server"), str_of(item, "tool"));
                            out.push(json!({ "kind": "tool", "name": name, "detail": "" }));
                        }
                    }
                    "web_search" => {
                        if self.shown.insert(id) {
                            out.push(json!({ "kind": "tool", "name": "WebSearch", "detail": clip(str_of(item, "query")) }));
                        }
                    }
                    _ => {}
                }
            }
            "turn.completed" => {
                self.finished = true;
                out.push(json!({ "kind": "result", "text": self.last_message, "is_error": false }));
            }
            "turn.failed" => {
                self.finished = true;
                let msg = v
                    .get("error")
                    .map(|e| str_of(e, "message").to_string())
                    .filter(|m| !m.is_empty())
                    .or_else(|| self.last_error.clone())
                    .unwrap_or_else(|| "Codex stopped with an error.".to_string());
                out.push(json!({ "kind": "result", "text": msg, "is_error": true }));
            }
            "error" => {
                let msg = str_of(v, "message");
                if !msg.is_empty() {
                    self.last_error = Some(msg.to_string());
                }
            }
            _ => {}
        }
        out
    }
}

/// The Codex thread to resume, if `resume` is one of ours.
fn codex_thread(resume: Option<&str>) -> Option<&str> {
    resume.and_then(|r| r.strip_prefix(SESSION_PREFIX)).filter(|r| !r.is_empty())
}

fn exec_args(thread: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = vec!["exec".into()];
    if thread.is_some() {
        a.push("resume".into());
    }
    for f in ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"] {
        a.push(f.into());
    }
    if let Some(t) = thread {
        a.push(t.into());
    }
    // The prompt comes on stdin: no length limit, no quoting problems.
    a.push("-".into());
    a
}

#[tauri::command]
pub async fn codex_send(
    state: tauri::State<'_, crate::chat::ChatState>,
    message: String,
    cwd: String,
    resume: Option<String>,
    attachments: Option<Vec<String>>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let bin = find_codex()?;
    match login_state(&bin).await {
        Login::ChatGpt => {}
        Login::ApiKey => return Err(API_KEY_MODE.into()),
        Login::SignedOut => return Err(NOT_SIGNED_IN.into()),
    }
    // A chat that was talking to Claude has no Codex thread. Say so in the
    // words the chat panel already handles: it carries on in a fresh session
    // seeded with a recap of the conversation.
    if resume.as_deref().is_some_and(|r| !r.is_empty() && !r.starts_with(SESSION_PREFIX)) {
        return Err("No conversation found for Codex in this chat (it was with Claude).".into());
    }
    let thread = codex_thread(resume.as_deref());
    let prompt = crate::chat::prompt_with_attachments(&message, &attachments.unwrap_or_default());

    let mut std_cmd = std::process::Command::new(&bin);
    std_cmd
        .args(exec_args(thread))
        .env("CODEX_MANAGED_BY_NPM", "1")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hidden(&mut std_cmd);
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch codex: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Couldn't send the message to codex: {e}"))?;
        drop(stdin);
    }
    let stdout = child.stdout.take().ok_or("No stdout from codex")?;
    let stderr = child.stderr.take();
    {
        let mut guard = state.child.lock().await;
        if let Some(old) = guard.as_mut() {
            let _ = old.start_kill();
        }
        *guard = Some(child);
    }

    let mut tr = Translator::default();
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        for e in tr.events(&v) {
            let _ = on_event.send(e);
        }
    }

    let mut stderr_buf = String::new();
    if let Some(se) = stderr {
        let mut lines = BufReader::new(se).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            stderr_buf.push_str(&l);
            stderr_buf.push('\n');
            if stderr_buf.len() > 4000 {
                break;
            }
        }
    }
    let (aborted, exit_code) = {
        let child = state.child.lock().await.take();
        match child {
            Some(mut c) => {
                let code = match tokio::time::timeout(std::time::Duration::from_secs(3), c.wait()).await {
                    Ok(Ok(status)) => status.code(),
                    _ => {
                        let _ = c.start_kill();
                        None
                    }
                };
                (false, code)
            }
            None => (true, None),
        }
    };
    if !tr.finished && !aborted && tr.session.is_some() {
        // Started but never finished: report it the way the panel resumes from.
        let why = tr.last_error.clone().unwrap_or_else(|| stderr_buf.trim().to_string());
        let text = if why.is_empty() {
            "Connection stopped (stream ended early)".to_string()
        } else {
            format!("Connection stopped (stream ended early)\n{why}")
        };
        let _ = on_event.send(json!({ "kind": "result", "text": text, "is_error": true }));
    }
    let _ = on_event.send(json!({ "kind": "done", "stderr": stderr_buf.trim(), "code": exit_code }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(lines: &[&str]) -> (Translator, Vec<Value>) {
        let mut tr = Translator::default();
        let mut out = Vec::new();
        for l in lines {
            out.extend(tr.events(&serde_json::from_str(l).unwrap()));
        }
        (tr, out)
    }

    #[test]
    fn a_turn_becomes_session_steps_and_result() {
        let (tr, ev) = run(&[
            r#"{"type":"thread.started","thread_id":"0199a"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"Listing files"}}"#,
            r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"a.txt\n","exit_code":0,"status":"completed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"b.txt","kind":"add"},{"path":"a.txt","kind":"update"}],"status":"completed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}"#,
        ]);
        let kinds: Vec<&str> = ev.iter().map(|e| e["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["session", "thinking", "tool", "tool", "tool", "text", "result"]);
        assert_eq!(ev[0]["id"], "codex:0199a");
        assert_eq!(ev[2]["detail"], "bash -lc ls"); // shown once, not twice
        assert_eq!(ev[3]["name"], "Created");
        assert_eq!(ev[4]["name"], "Edited");
        assert_eq!(ev[6]["text"], "Done.");
        assert_eq!(ev[6]["is_error"], false);
        assert!(tr.finished);
    }

    #[test]
    fn a_failed_turn_is_an_error_result() {
        let (_, ev) = run(&[
            r#"{"type":"thread.started","thread_id":"t"}"#,
            r#"{"type":"error","message":"Reconnecting... 1/5"}"#,
            r#"{"type":"turn.failed","error":{"message":"usage limit reached"}}"#,
        ]);
        let last = ev.last().unwrap();
        assert_eq!(last["kind"], "result");
        assert_eq!(last["is_error"], true);
        assert_eq!(last["text"], "usage limit reached");
    }

    #[test]
    fn resume_only_takes_codex_threads() {
        assert_eq!(codex_thread(Some("codex:abc")), Some("abc"));
        assert_eq!(codex_thread(Some("9f1e-claude-session")), None);
        assert_eq!(codex_thread(Some("codex:")), None);
        assert_eq!(codex_thread(None), None);
        assert_eq!(exec_args(None), ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-"]);
        assert_eq!(exec_args(Some("abc"))[..2], ["exec", "resume"]);
        assert_eq!(exec_args(Some("abc")).last().unwrap(), "-");
    }

    #[test]
    fn login_status_wording() {
        assert_eq!(parse_login_status("Logged in using ChatGPT\n"), Login::ChatGpt);
        assert_eq!(parse_login_status("Logged in using an API key - sk-ab***"), Login::ApiKey);
        assert_eq!(parse_login_status("Not logged in"), Login::SignedOut);
    }

    #[test]
    fn npm_layouts_are_searched() {
        let c = npm_native_candidates(Path::new("/nm"));
        let (pkg, triple) = TRIPLES[0];
        assert!(c.contains(&Path::new("/nm/@openai/codex/node_modules").join(pkg).join("vendor").join(triple).join("bin").join(EXE)));
    }
}
