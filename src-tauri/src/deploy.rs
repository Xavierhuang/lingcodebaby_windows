// Cloud deploy backend: packages a folder as a static site and ships it to the
// LingCode Cloud (Cloudflare Workers) API. Ported from CloudDeploy.m. The UI
// drives the dialogs (subdomain / token prompts); these commands do config I/O,
// token lookup, availability checks, and the package+upload+poll.

use flate2::write::GzEncoder;
use flate2::Compression;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;

const KEYCHAIN_SERVICE: &str = "LingCode";
const KEYCHAIN_ACCOUNT: &str = "lingcode_auth_access_token";
const SKIP: &[&str] = &[".git", ".DS_Store", "node_modules", ".env", ".lingcodedeploy.json"];

fn api_base() -> String {
    std::env::var("LINGCODE_API_BASE").unwrap_or_else(|_| "https://lingcode.dev".to_string())
}

fn config_path(folder: &str) -> PathBuf {
    Path::new(folder).join(".lingcodedeploy.json")
}

/// The LingCode site base URL (where the user signs in to get a token).
#[tauri::command]
pub fn deploy_api_base() -> String {
    api_base()
}

#[tauri::command]
pub fn deploy_load_config(folder: String) -> Value {
    match std::fs::read(config_path(&folder)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

#[tauri::command]
pub fn deploy_save_config(folder: String, config: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    let path = config_path(&folder);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    // 0600 on Unix; on Windows ACLs are left at default.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Look up a saved access token: OS credential store first, then env var.
#[tauri::command]
pub fn deploy_get_saved_token() -> Option<String> {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        if let Ok(tok) = entry.get_password() {
            if !tok.is_empty() {
                return Some(tok);
            }
        }
    }
    std::env::var("LINGCODE_ACCESS_TOKEN").ok().filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn deploy_save_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())
}

/// Append a diagnostic line to %TEMP%/lingcodebaby-signin.log (best-effort).
fn signin_log(msg: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("lingcodebaby-signin.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{msg}");
    }
}

/// Minimal percent-decoder for query values (token/session come back URL-encoded).
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Extract a query parameter value from an HTTP request line ("GET /?a=b&c=d HTTP/1.1").
fn query_param(request_line: &str, key: &str) -> Option<String> {
    let path = request_line.split_whitespace().nth(1)?;
    let q = path.split_once('?')?.1;
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Sign in via the LingCode device-flow: start a localhost listener, open the
/// browser to cli-token.html with a one-time session + redirect, and capture the
/// `lcat_…` token the page hands back. Returns the token (also saved to the OS
/// credential store). No copy/paste required.
#[tauri::command]
pub async fn deploy_signin(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // Bind IPv4 loopback and hand the browser an explicit 127.0.0.1 redirect, so
    // it can't resolve "localhost" to ::1 (IPv6) where nothing is listening.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Couldn't start local sign-in listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let session = uuid::Uuid::new_v4().to_string();
    let url = format!(
        "{}/cli-token.html?session={}&redirect=http://127.0.0.1:{}",
        api_base(),
        session,
        port
    );
    signin_log(&format!("opening {url}"));

    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|e| format!("Couldn't open the browser: {e}"))?;

    // Wait (up to 5 minutes) for the browser to redirect the token back.
    let token = tokio::time::timeout(std::time::Duration::from_secs(300), async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
            let req = String::from_utf8_lossy(&buf[..n]);
            let line = req.lines().next().unwrap_or("").to_string();

            let got_session = query_param(&line, "session").map(|s| url_decode(&s));
            let got_token = query_param(&line, "token").map(|s| url_decode(&s));
            signin_log(&format!(
                "request: {line} | session_match={} | token_len={}",
                got_session.as_deref() == Some(session.as_str()),
                got_token.as_deref().map(|t| t.len()).unwrap_or(0)
            ));

            let body = "<!doctype html><html><body style=\"font-family:system-ui,sans-serif;text-align:center;padding:48px;background:#1e1e1e;color:#eee\"><h2>\u{2713} Signed in to LingCodeBaby</h2><p>You can close this tab and return to the app.</p></body></html>";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;

            // Capture the token from the request whose session matches ours and
            // that carries a non-empty token (the real token is a bare ~64-char
            // hex string, no fixed prefix). The ephemeral one-shot port already
            // scopes this to our own sign-in.
            if let Some(tok) = got_token {
                let session_ok = got_session.as_deref() == Some(session.as_str());
                if !tok.is_empty() && tok.len() >= 16 && (session_ok || tok.len() >= 32) {
                    signin_log("captured token, returning");
                    return Ok::<String, String>(tok);
                }
            }
            // Ignore unrelated requests (e.g. favicon.ico) and keep waiting.
        }
    })
    .await
    .map_err(|_| {
        signin_log("timed out waiting for browser redirect");
        "Sign-in timed out. Try again, or paste a token manually.".to_string()
    })??;

    // Persist to the OS credential store (best-effort).
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        let _ = entry.set_password(&token);
    }
    Ok(token)
}

/// Slugify a string client-side, matching the server's rules.
#[tauri::command]
pub fn deploy_slugify(input: String) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    trimmed.chars().take(40).collect()
}

#[tauri::command]
pub fn deploy_has_index(folder: String) -> bool {
    Path::new(&folder).join("index.html").is_file()
}

/// Verify a token + check subdomain availability.
#[tauri::command]
pub async fn deploy_check(
    token: String,
    slug: String,
    exclude: Option<String>,
) -> Result<Value, String> {
    let mut url = format!("{}/api/account/cloud-workers/check?slug={}", api_base(), slug);
    if let Some(ex) = exclude.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&exclude={}", ex));
    }
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach LingCode Cloud: {e}"))?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    Ok(json!({
        "status": status,
        "available": body.get("available").and_then(|b| b.as_bool()).unwrap_or(false),
        "reason": body.get("reason").and_then(|s| s.as_str()).unwrap_or(""),
        "message": body.get("message").and_then(|s| s.as_str())
            .or_else(|| body.get("error").and_then(|s| s.as_str())).unwrap_or(""),
    }))
}

fn human_error(status: u16, message: &str) -> String {
    if !message.is_empty() {
        return message.to_string();
    }
    match status {
        400 => "Invalid subdomain. Use 3–40 characters: lowercase letters, digits and dashes.",
        401 => "Sign in to LingCode Cloud first.",
        403 => "You don't have permission to deploy this app.",
        404 => "App not found — it may have been deleted.",
        409 => "That subdomain is taken, or you've reached your app limit.",
        413 => "The bundle is too large.",
        429 => "Too many deploys — wait a bit and try again.",
        503 => "Cloud hosting is temporarily unavailable.",
        _ => "Deploy failed.",
    }
    .to_string()
}

/// Build the gzip'd tar bundle (dist/server/{wrangler.json,_worker.js,public/}).
fn build_bundle(folder: &str) -> Result<Vec<u8>, String> {
    let wrangler = json!({
        "name": "lingcode-app",
        "main": "_worker.js",
        "compatibility_date": "2025-03-01",
        "compatibility_flags": ["nodejs_compat"],
        "assets": {
            "directory": "public",
            "binding": "ASSETS",
            "not_found_handling": "single-page-application"
        }
    });
    let worker_js = "export default {\n  async fetch(request, env) {\n    return env.ASSETS.fetch(request);\n  }\n};\n";

    let gz = GzEncoder::new(Vec::new(), Compression::default());
    let mut tar = tar::Builder::new(gz);

    // dist/server/wrangler.json
    let wbytes = serde_json::to_vec_pretty(&wrangler).map_err(|e| e.to_string())?;
    append_bytes(&mut tar, "dist/server/wrangler.json", &wbytes)?;
    append_bytes(&mut tar, "dist/server/_worker.js", worker_js.as_bytes())?;

    // dist/server/public/<folder contents>, skipping VCS/dotfiles/token.
    let root = Path::new(folder);
    for entry in walkdir::WalkDir::new(root).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !SKIP.contains(&name.as_ref())
    }) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let arc = format!("dist/server/public/{}", rel);
        let data = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
        append_bytes(&mut tar, &arc, &data)?;
    }

    let gz = tar.into_inner().map_err(|e| e.to_string())?;
    gz.finish().map_err(|e| e.to_string())
}

fn append_bytes<W: Write>(
    tar: &mut tar::Builder<W>,
    path: &str,
    data: &[u8],
) -> Result<(), String> {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, path, data).map_err(|e| e.to_string())
}

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

/// Package + upload (POST for new, PUT for redeploy) + poll the job.
/// Returns { url, workerId }.
#[tauri::command]
pub async fn deploy_upload(
    folder: String,
    token: String,
    slug: Option<String>,
    title: String,
    worker_id: Option<String>,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let _ = on_event.send(json!({ "kind": "status", "text": "Packaging files…" }));
    let bundle = build_bundle(&folder)?;

    let _ = on_event.send(json!({ "kind": "status", "text": "Uploading to LingCode Cloud…" }));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let base = api_base();
    let req = if let Some(id) = worker_id.as_ref().filter(|s| !s.is_empty()) {
        // Redeploy: PUT, keeps the existing subdomain (no X-App-Slug).
        client
            .put(format!("{}/api/account/cloud-workers/{}", base, id))
            .header("X-App-Title", enc(&title))
    } else {
        // First deploy: POST with the chosen subdomain.
        let mut r = client
            .post(format!("{}/api/account/cloud-workers", base))
            .header("X-App-Title", enc(&title));
        if let Some(s) = slug.as_ref() {
            r = r.header("X-App-Slug", enc(s));
        }
        r
    };

    let resp = req
        .header("Content-Type", "application/gzip")
        .bearer_auth(&token)
        .body(bundle)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach LingCode Cloud: {e}"))?;

    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let msg = body
            .get("message")
            .and_then(|s| s.as_str())
            .or_else(|| body.get("error").and_then(|s| s.as_str()))
            .unwrap_or("");
        return Err(human_error(status, msg));
    }

    let worker_id_out = body
        .get("id")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .or_else(|| worker_id.clone());

    // Legacy synchronous response with a URL.
    if let Some(url) = body.get("url").and_then(|u| u.as_str()) {
        return Ok(json!({ "url": url, "workerId": worker_id_out }));
    }

    // Async job: poll until success/failure (15-minute ceiling).
    let job_id = body
        .get("jobId")
        .and_then(|s| s.as_str())
        .ok_or("Server did not return a job id")?
        .to_string();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15 * 60);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("Deploy timed out. It may still finish — check your LingCode account.".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        let _ = on_event.send(json!({ "kind": "status", "text": "Building on the server…" }));
        let jr = client
            .get(format!("{}/api/account/cloud-workers/jobs/{}", base, job_id))
            .bearer_auth(&token)
            .send()
            .await;
        let jr = match jr {
            Ok(r) => r,
            Err(_) => continue, // transient; keep polling
        };
        let jbody: Value = jr.json().await.unwrap_or(Value::Null);
        match jbody.get("status").and_then(|s| s.as_str()) {
            Some("success") => {
                let url = jbody
                    .get("url")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| slug.as_ref().map(|s| format!("https://{}.lingcode.app/", s)))
                    .unwrap_or_default();
                return Ok(json!({ "url": url, "workerId": worker_id_out }));
            }
            Some("failed") => {
                let msg = jbody.get("message").and_then(|s| s.as_str()).unwrap_or("Deploy failed.");
                return Err(msg.to_string());
            }
            _ => continue,
        }
    }
}
