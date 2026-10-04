//! Remote access: this PC appears at lingcode.dev/remote for the signed-in
//! LingCode account, where a browser can chat with its agent — the same
//! service the Mac app uses (website/server/remote-routes.js + collab-server.js).
//!
//! Rust does the authenticated HTTP (registering the PC, helper links); the
//! frontend (src/remote.ts) holds the WebSocket and mirrors the chat, because
//! the chat's state lives there.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRegistration {
    pub host_id: String,
    pub name: String,
    /// wss://…/ws/collab/<hostId>/__serve?token=<account token>. The account
    /// token, not the 1-hour token the server offers, so the connection
    /// survives long sessions — as the Mac collab bridge does.
    pub ws_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperLink {
    pub url: String,
    pub expires_at: i64,
}

fn token() -> Result<String, String> {
    crate::deploy::deploy_get_saved_token()
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "Sign in to your LingCode account first.".to_string())
}

fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|n| !n.trim().is_empty())
        .map(|n| format!("{n} (LingCodeBaby)"))
        .unwrap_or_else(|| "Windows PC (LingCodeBaby)".to_string())
}

fn ws_base(api: &str) -> String {
    if let Some(rest) = api.strip_prefix("https://") { format!("wss://{rest}") }
    else if let Some(rest) = api.strip_prefix("http://") { format!("ws://{rest}") }
    else { api.to_string() }
}

async fn read_json(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() { return Ok(body); }
    if status.as_u16() == 401 { return Err("Your LingCode sign-in expired. Sign in again.".into()); }
    Err(body.get("error").and_then(|e| e.as_str()).map(String::from)
        .unwrap_or_else(|| format!("lingcode.dev answered {}", status.as_u16())))
}

/// Register (or refresh) this PC as a remote host and return how to connect.
#[tauri::command]
pub async fn remote_register() -> Result<RemoteRegistration, String> {
    let token = token()?;
    let api = crate::deploy::api_base();
    let mut prefs = crate::prefs::get_prefs();
    let name = computer_name();
    let mut body = json!({ "name": name });
    if !prefs.remote_host_id.is_empty() { body["id"] = json!(prefs.remote_host_id); }
    let resp = reqwest::Client::new()
        .post(format!("{api}/api/remote/hosts"))
        .bearer_auth(&token)
        .json(&body)
        .send().await.map_err(|e| format!("Couldn't reach lingcode.dev: {e}"))?;
    let j = read_json(resp).await?;
    let host_id = j.pointer("/host/id").and_then(|v| v.as_str()).ok_or("lingcode.dev sent no host id")?.to_string();
    if prefs.remote_host_id != host_id {
        prefs.remote_host_id = host_id.clone();
        crate::prefs::set_prefs(prefs)?;
    }
    let token_q: String = percent_encoding::utf8_percent_encode(&token, percent_encoding::NON_ALPHANUMERIC).to_string();
    Ok(RemoteRegistration {
        ws_url: format!("{}/ws/collab/{host_id}/__serve?token={token_q}", ws_base(&api)),
        host_id,
        name,
    })
}

/// "Invite a helper": a link that lets someone chat with this PC's agent for
/// two hours (never its terminal). Revoke with `remote_stop_sharing`.
#[tauri::command]
pub async fn remote_create_helper_link() -> Result<HelperLink, String> {
    let token = token()?;
    let host_id = crate::prefs::get_prefs().remote_host_id;
    if host_id.is_empty() { return Err("Turn on Remote access first.".into()); }
    let resp = reqwest::Client::new()
        .post(format!("{}/api/remote/hosts/{host_id}/share", crate::deploy::api_base()))
        .bearer_auth(&token)
        .json(&json!({ "permission": "drive" }))
        .send().await.map_err(|e| format!("Couldn't reach lingcode.dev: {e}"))?;
    let j = read_json(resp).await?;
    Ok(HelperLink {
        url: j.get("url").and_then(|v| v.as_str()).ok_or("lingcode.dev sent no link")?.to_string(),
        expires_at: j.get("expires_at").and_then(|v| v.as_i64()).unwrap_or(0),
    })
}

/// Revoke every helper and view-only link for this PC.
#[tauri::command]
pub async fn remote_stop_sharing() -> Result<(), String> {
    let token = token()?;
    let host_id = crate::prefs::get_prefs().remote_host_id;
    if host_id.is_empty() { return Ok(()); }
    let resp = reqwest::Client::new()
        .delete(format!("{}/api/remote/hosts/{host_id}/shares", crate::deploy::api_base()))
        .bearer_auth(&token)
        .send().await.map_err(|e| format!("Couldn't reach lingcode.dev: {e}"))?;
    read_json(resp).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn websocket_base_follows_the_api_scheme() {
        assert_eq!(ws_base("https://lingcode.dev"), "wss://lingcode.dev");
        assert_eq!(ws_base("http://localhost:3000"), "ws://localhost:3000");
    }
}
