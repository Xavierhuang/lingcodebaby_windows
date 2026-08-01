// approval.rs — the tiered permission gate for hands-free voice mode.
//
// The problem: `claude -p` (print mode) can't show an interactive approval
// prompt, which is why chat.rs historically passed `--permission-mode
// bypassPermissions`. That means *nothing* was gated — including `rm -rf`, git
// push, and deploys. Fine for a hands-on IDE where you read every tool call;
// not fine when you're across the room talking to it.
//
// The fix uses a supported Claude Code mechanism rather than a hack:
// `--permission-prompt-tool <mcp tool>` (which only works with --print, i.e.
// exactly our mode). Claude calls that MCP tool for each permission decision
// with { tool_name, input, tool_use_id } and expects back
// { behavior: "allow", updatedInput } or { behavior: "deny", message }.
//
// So this module is a tiny local HTTP MCP server exposing one tool, `approve`:
//
//   safe  -> return allow immediately, silently. Reads and in-project edits.
//   risky -> ask the human out loud, wait for a spoken confirmation phrase.
//
// Bound to 127.0.0.1 on an ephemeral port with a per-run bearer token, because
// anything that can call this tool can approve arbitrary tool use.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// How long we wait for a spoken decision before giving up and denying.
///
/// Deliberately shorter than the agent's own patience: Claude rejects pending
/// permissions when a query ends, so a decision that arrives after the turn is
/// gone is worse than a clean deny the agent can report.
const SPOKEN_DECISION_TIMEOUT_SECS: u64 = 90;

// ── Tier classification ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// Auto-approve, say nothing. Reversible and confined to the project.
    Safe,
    /// Speak it and wait for a confirmation phrase.
    Risky,
}

/// Tools that only read, and so can never surprise you.
const READ_ONLY_TOOLS: &[&str] = &[
    "Read", "Grep", "Glob", "LS", "List", "NotebookRead", "TodoRead", "TodoWrite",
];

/// Tools that write files. Safe *only* when every path stays inside the project.
const WRITE_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"];

/// Always risky regardless of arguments: shells out, reaches the network, or
/// hands control to something we can't classify.
const ALWAYS_RISKY_TOOLS: &[&str] = &[
    "Bash", "BashOutput", "KillBash", "Execute", "Run",
    "WebFetch", "WebSearch", "Fetch",
    "Task", "Agent", // a subagent can call anything; classify at its own calls
];

/// Classify one permission request.
///
/// Unknown tools are Risky. That is the whole point of a default: an MCP server
/// the user installed later must not silently inherit auto-approval.
pub fn classify(tool_name: &str, input: &Value, project_root: &Path) -> Tier {
    // MCP tools are named mcp__<server>__<tool>. Our own approve tool is
    // internal plumbing; everything else third-party is unclassifiable.
    if tool_name.starts_with("mcp__") {
        return Tier::Risky;
    }
    if READ_ONLY_TOOLS.iter().any(|t| t.eq_ignore_ascii_case(tool_name)) {
        return Tier::Safe;
    }
    if ALWAYS_RISKY_TOOLS.iter().any(|t| t.eq_ignore_ascii_case(tool_name)) {
        return Tier::Risky;
    }
    if WRITE_TOOLS.iter().any(|t| t.eq_ignore_ascii_case(tool_name)) {
        return match paths_in_input(input)
            .iter()
            .all(|p| is_inside(project_root, p))
        {
            true => Tier::Safe,
            false => Tier::Risky, // escapes the project → ask
        };
    }
    Tier::Risky
}

/// Pull every plausible filesystem path out of a tool input blob.
///
/// We look at the conventional keys rather than every string, because scanning
/// all values would treat file *contents* as paths and produce nonsense.
fn paths_in_input(input: &Value) -> Vec<PathBuf> {
    const PATH_KEYS: &[&str] = &[
        "file_path", "path", "filePath", "notebook_path", "target_file", "old_path", "new_path",
    ];
    let mut out = Vec::new();
    if let Some(obj) = input.as_object() {
        for key in PATH_KEYS {
            if let Some(s) = obj.get(*key).and_then(|v| v.as_str()) {
                if !s.is_empty() {
                    out.push(PathBuf::from(s));
                }
            }
        }
        // MultiEdit-style batches: [{ file_path, ... }, ...]
        for key in ["edits", "files", "operations"] {
            if let Some(arr) = obj.get(key).and_then(|v| v.as_array()) {
                for item in arr {
                    out.extend(paths_in_input(item));
                }
            }
        }
    }
    out
}

/// Is `candidate` inside `root` after resolving `.` / `..` lexically?
///
/// Lexical rather than canonicalized on purpose: the file usually does not
/// exist yet (that's the point of a Write), so `canonicalize()` would fail and
/// we'd have to guess. Lexical normalization still defeats `../../etc/passwd`,
/// which is the attack that matters. A symlink inside the project that points
/// out of it is NOT caught here — noted as a known limitation rather than
/// silently pretended away.
fn is_inside(root: &Path, candidate: &Path) -> bool {
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let norm = |p: &Path| -> PathBuf {
        let mut out = PathBuf::new();
        for c in p.components() {
            match c {
                Component::ParentDir => {
                    out.pop();
                }
                Component::CurDir => {}
                other => out.push(other.as_os_str()),
            }
        }
        out
    };
    let (r, c) = (norm(root), norm(&joined));
    // Path::starts_with compares WHOLE COMPONENTS, which is load-bearing here.
    // A byte-wise prefix test would treat "/project-evil/x" as inside "/proj"
    // and auto-approve it. Do not "simplify" this to string prefix matching.
    !r.as_os_str().is_empty() && c.starts_with(&r)
}

/// A short spoken description of what's being asked for. Kept terse because
/// this gets read aloud — a 300-character Bash command is unlistenable.
pub fn spoken_summary(tool_name: &str, input: &Value) -> String {
    let brief = |s: &str, n: usize| -> String {
        let t = s.trim().replace('\n', " ");
        if t.chars().count() > n {
            let cut: String = t.chars().take(n).collect();
            format!("{cut}…")
        } else {
            t
        }
    };
    match tool_name {
        "Bash" | "Execute" | "Run" => {
            let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
            format!("run the command {}", brief(cmd, 120))
        }
        "WebFetch" | "Fetch" => {
            let url = input.get("url").and_then(|v| v.as_str()).unwrap_or("");
            format!("fetch {}", brief(url, 80))
        }
        "WebSearch" => "search the web".to_string(),
        _ => {
            let p = paths_in_input(input);
            match p.first() {
                Some(path) => format!("use {tool_name} on {}", path.display()),
                None => format!("use {tool_name}"),
            }
        }
    }
}

// ── Pending-decision registry ──────────────────────────────────────────────

/// One risky request awaiting a spoken answer. Pure data — the waiting half
/// (the oneshot sender) stays in `ApprovalState.pending`, keyed by `id`.
#[derive(Clone, Serialize)]
pub struct Pending {
    pub id: String,
    pub tool_name: String,
    pub summary: String,
}

#[derive(Default)]
pub struct ApprovalState {
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    seq: AtomicU64,
}

impl ApprovalState {
    fn next_id(&self) -> String {
        format!("appr-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    /// Resolve a pending request. Returns false if the id is unknown (already
    /// timed out, or the turn ended and we dropped it).
    pub fn resolve(&self, id: &str, allow: bool) -> bool {
        let tx = self.pending.lock().ok().and_then(|mut m| m.remove(id));
        match tx {
            Some(tx) => tx.send(allow).is_ok(),
            None => false,
        }
    }

    /// Deny everything outstanding. Called when a turn ends so we never leave a
    /// spoken question hanging with no turn behind it.
    pub fn drain_deny(&self) {
        if let Ok(mut m) = self.pending.lock() {
            for (_, tx) in m.drain() {
                let _ = tx.send(false);
            }
        }
    }
}

// ── The MCP server ─────────────────────────────────────────────────────────

/// Handle returned to chat.rs: the flags to pass `claude`, plus the shared state.
pub struct ApprovalServer {
    pub port: u16,
    pub token: String,
    pub state: Arc<ApprovalState>,
}

impl ApprovalServer {
    /// The `--mcp-config` JSON. Streamable-HTTP transport, since a stdio server
    /// would mean shipping a second executable inside the app bundle.
    pub fn mcp_config_json(&self) -> String {
        json!({
            "mcpServers": {
                "lingcode_voice": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{}/mcp", self.port),
                    "headers": { "Authorization": format!("Bearer {}", self.token) }
                }
            }
        })
        .to_string()
    }

    /// The fully-qualified tool name Claude must be told to use.
    pub fn permission_tool_name() -> &'static str {
        "mcp__lingcode_voice__approve"
    }
}

#[derive(Serialize, Deserialize)]
struct JsonRpcReq {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

/// Ask the human, out loud, and wait. `speak` is how we reach the webview.
type SpeakFn = Arc<dyn Fn(Pending) + Send + Sync>;

/// Start the local approval MCP server. Returns once it's bound and listening.
///
/// Takes the `ApprovalState` from the caller rather than creating it, so the
/// Tauri-managed handle and the server share one registry — otherwise
/// `voice_approve_resolve` would be resolving ids in a different map than the
/// one the server is waiting on, and every spoken approval would time out.
pub async fn start_with_state(
    project_root: Arc<Mutex<PathBuf>>,
    speak: SpeakFn,
    state: Arc<ApprovalState>,
) -> Result<ApprovalServer, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("couldn't bind the approval server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("no local addr: {e}"))?
        .port();

    // 32 hex chars of process-local randomness. Not a secret at rest — it lives
    // only in this process and the child's argv — but it stops any other local
    // process from POSTing itself an approval.
    let token: String = {
        let mut t = String::new();
        for _ in 0..4 {
            t.push_str(&format!("{:08x}", rand_u32()));
        }
        t
    };

    let server = ApprovalServer {
        port,
        token: token.clone(),
        state: state.clone(),
    };

    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let (state, token, root, speak) =
                (state.clone(), token.clone(), project_root.clone(), speak.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                // Read one HTTP request: headers, then Content-Length bytes.
                let body_start = loop {
                    match sock.read(&mut chunk).await {
                        Ok(0) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        Err(_) => return,
                    }
                    if let Some(i) = find_headers_end(&buf) {
                        break i;
                    }
                    if buf.len() > 1 << 20 {
                        return;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..body_start]).to_string();
                let want = content_length(&head).unwrap_or(0);
                while buf.len() < body_start + want {
                    match sock.read(&mut chunk).await {
                        Ok(0) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        Err(_) => break,
                    }
                }

                // Bearer check before we look at anything else.
                if !head
                    .to_ascii_lowercase()
                    .contains(&format!("authorization: bearer {}", token.to_ascii_lowercase()))
                {
                    let _ = sock.write_all(&http(401, "application/json", b"{\"error\":\"unauthorized\"}")).await;
                    return;
                }

                let body = &buf[body_start.min(buf.len())..];
                // Read the root at decision time: the user can open a different
                // project between turns without restarting the server.
                let current_root = root
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_else(|_| PathBuf::new());
                let reply = handle_rpc(body, &state, &current_root, &speak).await;
                let _ = sock
                    .write_all(&http(200, "application/json", reply.as_bytes()))
                    .await;
                let _ = sock.flush().await;
            });
        }
    });

    Ok(server)
}

async fn handle_rpc(
    body: &[u8],
    state: &Arc<ApprovalState>,
    project_root: &Path,
    speak: &SpeakFn,
) -> String {
    let req: JsonRpcReq = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => return rpc_err(Value::Null, -32700, &format!("parse error: {e}")),
    };
    let id = req.id.clone().unwrap_or(Value::Null);

    match req.method.as_str() {
        "initialize" => rpc_ok(
            id,
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "lingcode_voice", "version": "1.0.0" }
            }),
        ),
        "notifications/initialized" => String::new(), // notification: no reply
        "tools/list" => rpc_ok(
            id,
            json!({ "tools": [{
                "name": "approve",
                "description": "Decide whether a tool call may run. Safe, in-project \
                                operations are allowed automatically; anything that runs \
                                commands, reaches the network, or touches files outside \
                                the project is read aloud to the user, who must confirm \
                                it by voice.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tool_name": { "type": "string" },
                        "input": { "type": "object" },
                        "tool_use_id": { "type": "string" }
                    },
                    "required": ["tool_name", "input"]
                }
            }] }),
        ),
        "tools/call" => {
            let name = req.params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name != "approve" {
                return rpc_err(id, -32602, &format!("unknown tool: {name}"));
            }
            let args = req.params.get("arguments").cloned().unwrap_or(json!({}));
            let tool_name = args.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
            let input = args.get("input").cloned().unwrap_or(json!({}));

            let decision = match classify(tool_name, &input, project_root) {
                Tier::Safe => allow_result(&input),
                Tier::Risky => {
                    let (tx, rx) = oneshot::channel();
                    let id_str = state.next_id();
                    if let Ok(mut m) = state.pending.lock() {
                        m.insert(id_str.clone(), tx);
                    }
                    (**speak)(Pending {
                        id: id_str.clone(),
                        tool_name: tool_name.to_string(),
                        summary: spoken_summary(tool_name, &input),
                    });
                    let waited = tokio::time::timeout(
                        std::time::Duration::from_secs(SPOKEN_DECISION_TIMEOUT_SECS),
                        rx,
                    )
                    .await;
                    // Clean up on timeout so a late answer can't resolve a dead id.
                    if waited.is_err() {
                        if let Ok(mut m) = state.pending.lock() {
                            m.remove(&id_str);
                        }
                    }
                    match waited {
                        Ok(Ok(true)) => allow_result(&input),
                        Ok(Ok(false)) => deny_result("You declined this step out loud."),
                        Ok(Err(_)) => deny_result("The approval channel closed before you answered."),
                        Err(_) => deny_result(
                            "No spoken confirmation arrived in time, so this step was skipped.",
                        ),
                    }
                }
            };

            // MCP tool results carry their payload as a text content block; the
            // permission-prompt-tool contract parses that text as JSON.
            rpc_ok(
                id,
                json!({ "content": [{ "type": "text", "text": decision.to_string() }] }),
            )
        }
        other => rpc_err(id, -32601, &format!("method not found: {other}")),
    }
}

/// Only ever emit exactly "allow" or "deny". Anything unrecognized is treated as
/// ALLOW by the consuming side, so a typo here would fail open.
fn allow_result(input: &Value) -> Value {
    json!({ "behavior": "allow", "updatedInput": input })
}

fn deny_result(message: &str) -> Value {
    json!({ "behavior": "deny", "message": message })
}

fn rpc_ok(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn rpc_err(id: Value, code: i32, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

fn http(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        _ => "Error",
    };
    let mut out = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

fn content_length(head: &str) -> Option<usize> {
    head.lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse().ok())
}

/// Small non-crypto RNG. Only used to make the loopback token unguessable by
/// another local process; it is not protecting anything at rest.
fn rand_u32() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let n = nanos ^ (CTR.fetch_add(0x9E37_79B9, Ordering::Relaxed));
    let mut x = n as u32 ^ (std::process::id());
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    x
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root() -> PathBuf {
        PathBuf::from(if cfg!(windows) { r"C:\proj" } else { "/proj" })
    }
    fn p(s: &str) -> String {
        if cfg!(windows) { format!(r"C:\proj\{s}") } else { format!("/proj/{s}") }
    }

    #[test]
    fn reads_are_safe() {
        for t in ["Read", "Grep", "Glob", "LS"] {
            assert_eq!(classify(t, &json!({ "path": p("a.txt") }), &root()), Tier::Safe, "{t}");
        }
    }

    #[test]
    fn in_project_writes_are_safe() {
        assert_eq!(
            classify("Edit", &json!({ "file_path": p("src/main.rs") }), &root()),
            Tier::Safe
        );
        assert_eq!(classify("Write", &json!({ "file_path": "src/new.rs" }), &root()), Tier::Safe);
    }

    #[test]
    fn writes_escaping_the_project_are_risky() {
        let outside = if cfg!(windows) { r"C:\Windows\system32\drivers\etc\hosts" } else { "/etc/hosts" };
        assert_eq!(classify("Write", &json!({ "file_path": outside }), &root()), Tier::Risky);
        // The traversal case — this is the one that matters.
        assert_eq!(
            classify("Edit", &json!({ "file_path": "../../etc/passwd" }), &root()),
            Tier::Risky
        );
    }

    #[test]
    fn a_sibling_dir_sharing_a_name_prefix_is_not_inside() {
        // Guards the component-wise contract of Path::starts_with.
        let sibling = if cfg!(windows) { r"C:\proj-evil\x" } else { "/proj-evil/x" };
        assert_eq!(classify("Write", &json!({ "file_path": sibling }), &root()), Tier::Risky);
    }

    #[test]
    fn shell_and_network_are_always_risky() {
        assert_eq!(classify("Bash", &json!({ "command": "ls" }), &root()), Tier::Risky);
        assert_eq!(classify("WebFetch", &json!({ "url": "https://x.dev" }), &root()), Tier::Risky);
    }

    #[test]
    fn unknown_and_mcp_tools_default_to_risky() {
        assert_eq!(classify("SomeFutureTool", &json!({}), &root()), Tier::Risky);
        assert_eq!(classify("mcp__other__do_thing", &json!({}), &root()), Tier::Risky);
    }

    #[test]
    fn multiedit_is_risky_if_any_path_escapes() {
        let mixed = json!({ "edits": [
            { "file_path": p("ok.rs") },
            { "file_path": "../../../etc/shadow" }
        ]});
        assert_eq!(classify("MultiEdit", &mixed, &root()), Tier::Risky);
    }

    #[test]
    fn decisions_are_exactly_allow_or_deny() {
        assert_eq!(allow_result(&json!({}))["behavior"].as_str().unwrap(), "allow");
        assert_eq!(deny_result("no")["behavior"].as_str().unwrap(), "deny");
    }

    #[test]
    fn spoken_summary_is_short_enough_to_listen_to() {
        let long = "a".repeat(500);
        let s = spoken_summary("Bash", &json!({ "command": long }));
        assert!(s.chars().count() < 160, "too long to speak: {}", s.len());
    }

    #[test]
    fn resolve_is_idempotent_and_unknown_ids_are_false() {
        let st = ApprovalState::default();
        assert!(!st.resolve("nope", true));
    }
}
