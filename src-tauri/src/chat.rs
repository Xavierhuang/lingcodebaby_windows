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

/// Model tag that routes the chat through the LingModel managed proxy (the
/// user's LingCode account) instead of their personal Claude subscription.
const LINGMODEL_TAG: &str = "lingmodel";
/// Upstream model id handed to the `claude` CLI when routing to LingModel.
/// Mirrors the main app's bridge.mjs `lingModelUpstream()`. Internal subprocess
/// arg only — never shown to the user (branding: surface "LingModel" only). The
/// server proxy can rewrite the real upstream, so this is effectively a family tag.
/// Also used by quinny.rs as `QUINNY_MODEL` so the bundled Quinny CLI routes
/// through the same proxy.
pub(crate) const LINGMODEL_UPSTREAM: &str = "kimi-k2.7";

const SYSTEM_PROMPT: &str = "You are embedded in a minimal IDE. Make focused changes to files in the working directory and briefly explain what you did.\n\nWhen you need the user to make a real decision or resolve an ambiguity, ask a multiple-choice question instead of guessing. To do that, reply with ONLY a fenced code block labeled ask_user containing JSON, and nothing else in that turn:\n```ask_user\n{\"question\": \"Which database should I use?\", \"options\": [\"SQLite\", \"Postgres\"]}\n```\n\nThe IDE renders each option as a clickable button and sends the user's choice back as the next message. The user may also type a custom answer. Use this only for genuine decisions — don't over-ask.\n\nTo keep token cost low, read, search, and list files by running shell commands through the Bash tool rather than the native Read, Grep, and Glob tools: use `cat`/`head` to read a file, `grep`/`rg` to search, and `ls`/`find` to list. Still use the native Edit/Write tools for changes.";

/// Appended to the system prompt when signed in, so the agent knows a LingCode
/// Cloud managed backend is wired into this workspace (see
/// fsops::scaffold_cloud_backend) and reaches for it instead of localStorage.
/// Verbatim short hint from the full app's LingCodeCloudMCPSetup.signedInHint;
/// the long capability detail is fetched live via describe_backend so it can't
/// go stale here.
const CLOUD_BACKEND_HINT: &str = "\n\nA LingCode Cloud managed backend (Postgres + auth + file storage + email + serverless functions + full-stack hosting) is available to this project via the `lingcode-cloud` MCP tools — call `describe_backend` to learn its current capabilities and limits BEFORE designing any data/auth/backend feature (don't guess, and don't reach for localStorage or tell the user to run an external server). If the app needs persistence or accounts, call `provision_backend` then `apply_migration`. The data API supports batch insert, upsert (ON CONFLICT), and `rpc()` for JOIN/aggregate/full-text reads — confirm specifics via `describe_backend`.";

/// Appended to the system prompt when the bundled Quinny CLI is available so
/// the agent knows it can reach for it. Verbatim from ClaudeChat.m:1327-1348.
const QUINNY_HINT: &str = "\n\nQuinny — an executable specification language, BUNDLED with this app and always on your PATH (also $QUINNY_BIN); just run `quinny …` via bash, no install needed. It VERIFIES code against acceptance criteria — it does NOT write the code for you (you write the code; you're better at it than a decomposing pipeline). Reach for it when a task has real correctness-critical LOGIC: pricing, cart/checkout math, business rules, state machines, validation, auth, parsing, calculations — the parts where a silent bug is expensive. Do NOT use it for UI/layout/styling, static pages, simple scripts, or one-off edits — it can't gate those and adds no value.\nWhen it fits:\n1. `quinny scaffold \"<what to build>\" -o <dir>` — drafts a `.qn` contract scoped to the verifiable logic, plus a module stub. (The user can describe it in plain English; scaffold writes the acceptance criteria for them.)\n2. Implement the module — write the real code.\n3. `quinny verify <contract>.qn <dir>` — runs the criteria against your code and reports per-criterion PASS/FAIL. Keep fixing until all gating (test) criteria pass.\n4. To lock it in, `quinny verify … --emit <name>_contract_test.py` and commit the .qn + suite so it re-runs deterministically in CI with no model.\nQuick reference: `quinny --help`. Rationale: agents write plausible code that 'looks done' but misses edge cases; verify makes 'is it correct?' an objective command, and the contract keeps catching regressions after you move on. (`quinny build`/`gen` code generation is experimental — prefer writing the code yourself.)";

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
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatState>,
    voice: tauri::State<'_, crate::VoiceApprovalHandle>,
    message: String,
    cwd: String,
    model: String,
    resume: Option<String>,
    // True when the turn was started by hands-free voice mode. Only then do we
    // swap `bypassPermissions` for the spoken approval gate — see the comment
    // at the flag site below for why this isn't unconditional.
    // (Plain `//`, not `///`: rustc allows only allow/cfg/cfg_attr/deny/expect/
    // forbid/warn as attributes on a function parameter, and a doc comment is
    // not one of them.)
    voice_mode: Option<bool>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let voice_mode = voice_mode.unwrap_or(false);
    let bin = find_claude().ok_or_else(|| {
        "Could not find the `claude` CLI. Install Claude Code and sign in with `claude login`.".to_string()
    })?;

    // When signed in, wire the LingCode Cloud backend into this workspace's
    // .mcp.json and hand the agent the token via the environment (kept out of
    // the on-disk config). The same account token also powers LingModel below.
    let cloud_token = crate::deploy::deploy_get_saved_token();
    if cloud_token.is_some() {
        crate::fsops::scaffold_cloud_backend(&cwd);
    }
    // Locate the bundled Quinny CLI once so we can (a) advertise it in the
    // system prompt, (b) prepend its dir to $PATH for the child, and
    // (c) point $QUINNY_BIN at it. Silent no-op when the frozen binary
    // isn't shipped yet — the hint is suppressed so we don't lie to the agent.
    let quinny_dir = crate::quinny::bundled_dir(&app);
    let mut system_prompt = SYSTEM_PROMPT.to_string();
    if cloud_token.is_some() {
        system_prompt.push_str(CLOUD_BACKEND_HINT);
    }
    if quinny_dir.is_some() {
        system_prompt.push_str(QUINNY_HINT);
    }

    // Build a std Command (so we can set Windows creation flags), then convert
    // to a tokio Command for async stdout streaming.
    let mut std_cmd = std::process::Command::new(&bin);
    std_cmd
        .arg("-p")
        .arg(&message)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--disallowedTools")
        .arg("AskUserQuestion")
        // Only load the opened project's config, NOT the user's global ~/.claude
        // (personal skills/plugins/SessionStart hooks) — otherwise a prompt like
        // "make X" can trip a global skill instead of running the task. Auth is
        // unaffected.
        .arg("--setting-sources")
        .arg("project,local")
        .arg("--append-system-prompt")
        .arg(&system_prompt);

    // ── Permission mode ────────────────────────────────────────────────────
    // Print mode can't render an interactive approval prompt, which is why this
    // has historically been `--permission-mode bypassPermissions` — i.e. nothing
    // gated at all, including `rm -rf`, git push and deploys.
    //
    // In VOICE mode we can do better, because there IS someone to ask: swap in
    // `--permission-prompt-tool`, which routes each decision to a local MCP tool
    // (approval.rs). Safe, in-project operations return allow instantly; risky
    // ones get read aloud and wait for a spoken confirmation phrase.
    //
    // Why this is not unconditional: with the gate on and no voice loop running,
    // there is nobody to answer, so every risky tool would sit for 90s and then
    // be denied. Fixing the non-voice case needs an on-screen approval dialog,
    // which is deliberately out of scope here — so hands-on behaviour is
    // unchanged, and that limitation is called out rather than papered over.
    if voice_mode {
        match voice.ensure_started(&app, std::path::PathBuf::from(&cwd)).await {
            Ok((mcp_config, tool_name)) => {
                std_cmd
                    .arg("--permission-mode")
                    .arg("default")
                    .arg("--permission-prompt-tool")
                    .arg(tool_name)
                    // Headless `claude -p` needs BOTH --mcp-config and
                    // --allowedTools for an MCP tool to be reachable. With only
                    // the former the tool silently never loads and the gate
                    // never fires — which would look like "voice approval is
                    // broken" with nothing in any log.
                    .arg("--mcp-config")
                    .arg(mcp_config)
                    .arg("--allowedTools")
                    .arg(crate::approval::ApprovalServer::permission_tool_name());
            }
            Err(e) => {
                // Fail closed. Silently falling back to bypassPermissions would
                // mean the user believes they have a spoken gate while the agent
                // runs completely unattended.
                return Err(format!(
                    "Voice mode couldn't start the approval gate, so the turn was not run: {e}"
                ));
            }
        }
    } else {
        std_cmd.arg("--permission-mode").arg("bypassPermissions");
    }
    if let Some(tok) = &cloud_token {
        // Expanded into the ${LINGCODE_CLOUD_TOKEN} .mcp.json header by the CLI.
        std_cmd.env("LINGCODE_CLOUD_TOKEN", tok);
    }
    // Make the bundled Quinny CLI available to the agent: prepend its dir to
    // PATH and point $QUINNY_BIN at it. Mirrors ClaudeChat.m:1445-1452.
    if let Some(dir) = quinny_dir.as_ref() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let existing = std::env::var("PATH").unwrap_or_default();
        std_cmd.env("PATH", format!("{}{}{}", dir.display(), sep, existing));
        std_cmd.env("QUINNY_BIN", dir.join(if cfg!(windows) { "quinny.exe" } else { "quinny" }));
    }
    // Endpoint routing priority (highest wins). Mirrors ClaudeChat.m:1462-1482.
    //   1. Custom endpoint (BYO URL + x-api-key) — overrides everything.
    //   2. LingModel proxy (LingCode account bearer).
    //   3. Personal Anthropic API key from Keychain (env fallback for signed-out).
    //   4. Claude subscription (env unchanged — CLI uses `claude login`).
    if crate::endpoint::is_active() {
        let prefs = crate::prefs::get_prefs();
        let key = crate::endpoint::get_key()
            .ok_or_else(|| "Custom endpoint enabled but key is missing.".to_string())?;
        std_cmd.env("ANTHROPIC_BASE_URL", &prefs.custom_endpoint_url);
        std_cmd.env("ANTHROPIC_API_KEY", &key);
        std_cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
        // Only pass `--model` when the picker has a specific choice; LingModel
        // routing is disabled here so lingmodel-tag falls back to letting the
        // custom endpoint pick its default.
        if model != LINGMODEL_TAG && model != "default" {
            std_cmd.arg("--model").arg(&model);
        }
    } else if model == LINGMODEL_TAG {
        // LingModel: route the same `claude` CLI at the LingCode proxy using the
        // user's LingCode account token, and hand the engine the upstream model.
        std_cmd.arg("--model").arg(LINGMODEL_UPSTREAM);
        std_cmd.env("ANTHROPIC_BASE_URL", crate::deploy::lingmodel_anthropic_base_url());
        match cloud_token.as_ref() {
            Some(tok) => {
                std_cmd.env("ANTHROPIC_AUTH_TOKEN", tok);
            }
            // Backstop — the frontend gate normally guarantees a token first.
            None => return Err("Sign in to LingCode to use LingModel.".to_string()),
        }
        // Never leak the user's real Anthropic key to the proxy.
        std_cmd.env_remove("ANTHROPIC_API_KEY");
        // The bundled Quinny CLI inherits these (agent → bash → quinny) and
        // uses the Bearer token; tell it which model to request through the
        // proxy. Mirrors ClaudeChat.m:1476.
        if quinny_dir.is_some() {
            std_cmd.env("QUINNY_MODEL", LINGMODEL_UPSTREAM);
        }
    } else {
        // Subscription path (`claude login`) — no env overrides — BUT if the
        // user has pasted a personal Anthropic key, hand it to the CLI so
        // signed-out users can still chat + run `quinny gen`. Env-set key
        // wins over `claude login` in the Anthropic SDK precedence.
        if let Some(k) = crate::anthropic_key::get() {
            std_cmd.env("ANTHROPIC_API_KEY", k);
        }
        if model != "default" {
            std_cmd.arg("--model").arg(&model);
        }
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
