// Claude chat backend: drives the `claude` CLI as a subprocess with
// --output-format stream-json, parses the newline-delimited JSON event stream,
// and forwards semantic events to the frontend over a Tauri Channel. Mirrors
// ClaudeChat.m. One turn in flight at a time; abort kills the child.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

pub struct ChatState {
    pub child: Mutex<Option<Child>>,
}

impl Default for ChatState {
    fn default() -> Self {
        ChatState { child: Mutex::new(None) }
    }
}

const SYSTEM_PROMPT: &str = "You are embedded in a minimal IDE. Make focused changes to files in the working directory and briefly explain what you did.\n\nWhen you need the user to make a real decision or resolve an ambiguity, ask a multiple-choice question instead of guessing. To do that, reply with ONLY a fenced code block labeled ask_user containing JSON, and nothing else in that turn:\n```ask_user\n{\"question\": \"Which database should I use?\", \"options\": [\"SQLite\", \"Postgres\"]}\n```\n\nThe IDE renders each option as a clickable button and sends the user's choice back as the next message. The user may also type a custom answer. Use this only for genuine decisions — don't over-ask.\n\nTo keep token cost low, read, search, and list files by running shell commands through the Bash tool rather than the native Read, Grep, and Glob tools: use `cat`/`head` to read a file, `grep`/`rg` to search, and `ls`/`find` to list. Still use the native Edit/Write tools for changes.";

/// Locate a `claude` executable, preferring a real binary over a shell shim.
fn find_claude() -> Option<PathBuf> {
    let home = dirs::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = &home {
        #[cfg(target_os = "windows")]
        {
            candidates.push(h.join(".local/bin/claude.exe"));
            candidates.push(h.join(".claude/local/claude.exe"));
            candidates.push(PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("npm/claude.cmd"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            for rel in [
                ".claude/local/claude",
                ".local/bin/claude",
                ".npm-global/bin/claude",
                ".bun/bin/claude",
                ".volta/bin/claude",
            ] {
                candidates.push(h.join(rel));
            }
            candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
            candidates.push(PathBuf::from("/usr/local/bin/claude"));
            candidates.push(PathBuf::from("/usr/bin/claude"));
        }
    }
    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    // Fall back to PATH resolution.
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(exe);
            if p.is_file() {
                return Some(p);
            }
            #[cfg(target_os = "windows")]
            {
                let cmd = dir.join("claude.cmd");
                if cmd.is_file() {
                    return Some(cmd);
                }
            }
        }
    }
    None
}

/// Extract a short one-line detail from a tool_use input object.
fn tool_detail(input: &Value) -> String {
    for key in ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description"] {
        if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
            let mut s = s.replace('\n', " ");
            if s.len() > 100 {
                s.truncate(100);
                s.push('\u{2026}');
            }
            return s;
        }
    }
    String::new()
}

/// Normalize an AskUserQuestion option (string or object) into a label string.
fn option_label(opt: &Value) -> Option<String> {
    if let Some(s) = opt.as_str() {
        return Some(s.to_string());
    }
    for key in ["label", "text", "title", "value", "name", "option"] {
        if let Some(s) = opt.get(key).and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

/// Parse an `ask_user` fenced JSON block out of free text. Returns (question, options).
fn parse_ask_user(text: &str) -> Option<(String, Vec<String>)> {
    let start = text.find("```ask_user")?;
    let after = &text[start + "```ask_user".len()..];
    let end = after.find("```")?;
    let body = after[..end].trim();
    let v: Value = serde_json::from_str(body).ok()?;
    let question = v.get("question")?.as_str()?.to_string();
    let options: Vec<String> = v
        .get("options")?
        .as_array()?
        .iter()
        .filter_map(option_label)
        .collect();
    if options.is_empty() {
        return None;
    }
    Some((question, options))
}

#[tauri::command]
pub async fn claude_send(
    state: tauri::State<'_, ChatState>,
    message: String,
    cwd: String,
    model: String,
    resume: Option<String>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let bin = find_claude().ok_or_else(|| {
        "Could not find the `claude` CLI. Install Claude Code and sign in with `claude login`.".to_string()
    })?;

    // Build a std Command (so we can set Windows creation flags), then convert
    // to a tokio Command for async stdout streaming.
    let mut std_cmd = std::process::Command::new(&bin);
    std_cmd
        .arg("-p")
        .arg(&message)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .arg("--disallowedTools")
        .arg("AskUserQuestion")
        .arg("--append-system-prompt")
        .arg(SYSTEM_PROMPT);
    if model != "default" {
        std_cmd.arg("--model").arg(&model);
    }
    if let Some(sid) = resume.as_ref().filter(|s| !s.is_empty()) {
        std_cmd.arg("--resume").arg(sid);
    }
    std_cmd
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW — keep the console of the CLI hidden.
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(0x08000000);
    }

    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch claude: {e}"))?;
    let stdout = child.stdout.take().ok_or("No stdout from claude")?;
    let stderr = child.stderr.take();

    // Store the child so claude_abort can kill it.
    {
        let mut guard = state.child.lock().await;
        // If a previous turn somehow lingers, kill it.
        if let Some(old) = guard.as_mut() {
            let _ = old.start_kill();
        }
        *guard = Some(child);
    }

    let mut reader = BufReader::new(stdout).lines();
    let mut interrupted = false; // AskUserQuestion ends the turn early
    let mut stderr_buf = String::new();

    while let Ok(Some(line)) = reader.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
            let _ = on_event.send(json!({ "kind": "session", "id": sid }));
        }

        match v.get("type").and_then(|t| t.as_str()) {
            Some("assistant") => {
                let content = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = content {
                    for block in blocks {
                        match block.get("type").and_then(|t| t.as_str()) {
                            Some("thinking") => {
                                let t = block.get("thinking").and_then(|x| x.as_str()).unwrap_or("");
                                if !t.trim().is_empty() {
                                    let _ = on_event.send(json!({ "kind": "thinking", "text": t }));
                                }
                            }
                            Some("text") => {
                                let t = block.get("text").and_then(|x| x.as_str()).unwrap_or("");
                                if !t.trim().is_empty() {
                                    let _ = on_event.send(json!({ "kind": "text", "text": t }));
                                }
                            }
                            Some("tool_use") => {
                                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                                let input = block.get("input").cloned().unwrap_or(Value::Null);
                                if name == "AskUserQuestion" {
                                    if let Some(q) = input
                                        .get("questions")
                                        .and_then(|qs| qs.as_array())
                                        .and_then(|qs| qs.first())
                                    {
                                        let question = q
                                            .get("question")
                                            .and_then(|x| x.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let options: Vec<String> = q
                                            .get("options")
                                            .and_then(|o| o.as_array())
                                            .map(|arr| arr.iter().filter_map(option_label).collect())
                                            .unwrap_or_default();
                                        let _ = on_event.send(
                                            json!({ "kind": "ask_user", "question": question, "options": options }),
                                        );
                                    }
                                    interrupted = true;
                                    break;
                                } else if name == "Edit" || name == "Write" || name == "MultiEdit" {
                                    let _ = on_event.send(
                                        json!({ "kind": "edit", "name": name, "input": input }),
                                    );
                                } else {
                                    let _ = on_event.send(json!({
                                        "kind": "tool",
                                        "name": name,
                                        "detail": tool_detail(&input)
                                    }));
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if interrupted {
                    break;
                }
            }
            Some("result") => {
                let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
                let text = v.get("result").and_then(|r| r.as_str()).unwrap_or("");
                if let Some((question, options)) = parse_ask_user(text) {
                    let _ = on_event
                        .send(json!({ "kind": "ask_user", "question": question, "options": options }));
                } else {
                    let _ = on_event
                        .send(json!({ "kind": "result", "text": text, "is_error": is_error }));
                }
            }
            _ => {}
        }
    }

    // Drain stderr (best-effort) for diagnostics if nothing else came through.
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

    // Clear / kill the stored child.
    {
        let mut guard = state.child.lock().await;
        if let Some(mut c) = guard.take() {
            let _ = c.start_kill();
        }
    }

    if interrupted {
        // Turn ended early on a question; suppress "done" so the UI shows chips.
        let _ = on_event.send(json!({ "kind": "awaiting" }));
    } else {
        let _ = on_event.send(json!({ "kind": "done", "stderr": stderr_buf.trim() }));
    }
    Ok(())
}

#[tauri::command]
pub async fn claude_abort(state: tauri::State<'_, ChatState>) -> Result<(), String> {
    let mut guard = state.child.lock().await;
    if let Some(child) = guard.as_mut() {
        let _ = child.start_kill();
    }
    *guard = None;
    Ok(())
}
