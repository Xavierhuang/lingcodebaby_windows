// voice.rs — the network half of hands-free voice mode.
//
// The webview captures the microphone and plays audio, but it cannot talk to
// lingcode.dev directly: tauri.conf.json pins the CSP to
// `connect-src 'self' ipc: http://ipc.localhost`. Rather than widen that (which
// would let any page-injected script reach the internet), all egress goes
// through these two commands. Two side benefits: the account token stays in
// Rust, and the speech vendor is never named client-side.
//
// Both commands are thin — the server does the vendor-specific work. That's
// deliberate: swapping speech providers should be a server env change, not a
// Baby release (which ships via NSIS/AppImage and takes days to reach users).

use serde::Serialize;
use tauri::Emitter;

/// Cap on a single utterance. A spoken instruction is seconds long; anything
/// larger is a stuck recorder, and we'd rather fail fast than bill for it.
const MAX_UPLOAD_BYTES: usize = 8 * 1024 * 1024;

/// Cap on text handed to the speech synthesiser. Matches MAX_TTS_CHARS in
/// website/server/voice-routes.js — if these drift the server 413s and the user
/// just hears nothing, which is a miserable failure mode to debug.
const MAX_SPEAK_CHARS: usize = 1200;

#[derive(Serialize)]
pub struct VoiceStatus {
    /// Voice needs an account: it costs money per utterance.
    pub signed_in: bool,
    pub transcribe: bool,
    pub speak: bool,
    /// Present when voice is unavailable — a reason to show the user, never a
    /// vendor name.
    pub reason: String,
}

fn api_base() -> String {
    std::env::var("LINGCODE_API_BASE").unwrap_or_else(|_| "https://lingcode.dev".to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| format!("Couldn't create the voice HTTP client: {e}"))
}

/// The account token also authorises voice. Reuses the same saved token the
/// deploy path uses, so signing in once covers both.
fn token() -> Option<String> {
    crate::deploy::deploy_get_saved_token()
}

/// Is voice usable right now? Called on startup so the mic button can be
/// disabled up front instead of failing on the first utterance.
#[tauri::command]
pub async fn voice_status() -> VoiceStatus {
    let Some(tok) = token() else {
        return VoiceStatus {
            signed_in: false,
            transcribe: false,
            speak: false,
            reason: "Sign in to LingCode to use voice mode.".to_string(),
        };
    };
    let url = format!("{}/api/voice/status", api_base());
    let Ok(c) = client() else {
        return VoiceStatus {
            signed_in: true,
            transcribe: false,
            speak: false,
            reason: "Couldn't start the voice client.".to_string(),
        };
    };
    match c.get(&url).bearer_auth(&tok).send().await {
        Ok(resp) => {
            let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
            let t = body.get("transcribe").and_then(|v| v.as_bool()).unwrap_or(false);
            let s = body.get("speak").and_then(|v| v.as_bool()).unwrap_or(false);
            VoiceStatus {
                signed_in: true,
                transcribe: t,
                speak: s,
                reason: if t && s { String::new() } else { "Voice isn't available on your account yet.".to_string() },
            }
        }
        Err(_) => VoiceStatus {
            signed_in: true,
            transcribe: false,
            speak: false,
            reason: "Couldn't reach LingCode to check voice availability.".to_string(),
        },
    }
}

/// Transcribe one utterance. `audio` is the raw recorded bytes; `mime` is the
/// container the webview's MediaRecorder produced (WebView2 typically lands on
/// audio/webm;codecs=opus).
#[tauri::command]
pub async fn voice_transcribe(audio: Vec<u8>, mime: String) -> Result<String, String> {
    if audio.is_empty() {
        return Err("Nothing was recorded — check the microphone.".to_string());
    }
    if audio.len() > MAX_UPLOAD_BYTES {
        return Err("That recording is too long. Try a shorter instruction.".to_string());
    }
    let tok = token().ok_or_else(|| "Sign in to LingCode to use voice mode.".to_string())?;

    // Strip codec parameters: the server matches on the bare type.
    let base_mime = mime.split(';').next().unwrap_or("audio/webm").trim().to_string();

    let url = format!("{}/api/voice/transcribe", api_base());
    let resp = client()?
        .post(&url)
        .bearer_auth(&tok)
        .header("content-type", base_mime)
        .body(audio)
        .send()
        .await
        .map_err(|_| "Couldn't reach the voice service.".to_string())?;

    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        return Err(voice_error_message(
            status,
            body.get("error").and_then(|v| v.as_str()).unwrap_or(""),
        ));
    }
    let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err("I didn't catch that — try again.".to_string());
    }
    Ok(text)
}

#[derive(Serialize)]
pub struct Shaped {
    /// The instruction, rewritten for the coding agent.
    pub prompt: String,
    /// One short line to read aloud, confirming intent before the turn runs.
    pub summary: String,
    /// True when shaping failed and this is the raw transcript. The caller
    /// should still offer it — a degraded prompt beats a dead session — but may
    /// want to say so.
    pub degraded: bool,
}

/// Turn loose speech into a well-formed prompt plus a spoken read-back.
#[tauri::command]
pub async fn voice_shape(text: String) -> Result<Shaped, String> {
    let heard = text.trim().to_string();
    if heard.is_empty() {
        return Err("I didn't catch that — try again.".to_string());
    }
    let tok = token().ok_or_else(|| "Sign in to LingCode to use voice mode.".to_string())?;

    let url = format!("{}/api/voice/shape", api_base());
    let resp = client()?
        .post(&url)
        .bearer_auth(&tok)
        .json(&serde_json::json!({ "text": heard }))
        .send()
        .await;

    // Shaping is an optimisation, not a dependency: if it fails for any reason,
    // hand back the raw transcript so the user can still say "go".
    let Ok(resp) = resp else {
        return Ok(Shaped { prompt: heard.clone(), summary: heard, degraded: true });
    };
    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        // 401 is worth surfacing — it's actionable. Everything else degrades.
        if status == 401 {
            return Err("Sign in to LingCode to use voice mode.".to_string());
        }
        return Ok(Shaped { prompt: heard.clone(), summary: heard, degraded: true });
    }
    let prompt = body.get("prompt").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let summary = body.get("summary").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let degraded = body.get("degraded").and_then(|v| v.as_bool()).unwrap_or(false);
    if prompt.is_empty() {
        return Ok(Shaped { prompt: heard.clone(), summary: heard, degraded: true });
    }
    let summary = if summary.is_empty() { prompt.clone() } else { summary };
    Ok(Shaped { prompt, summary, degraded })
}

/// Synthesise `text` and return the audio bytes plus their content type. The
/// webview plays them as a blob, which is the one playback path that behaves the
/// same in WebView2, webkit2gtk and WKWebView.
#[tauri::command]
pub async fn voice_speak(text: String) -> Result<(Vec<u8>, String), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Nothing to say.".to_string());
    }
    // Truncate on a character boundary rather than erroring: a slightly clipped
    // spoken summary is far better than silence.
    let body_text: String = if trimmed.chars().count() > MAX_SPEAK_CHARS {
        trimmed.chars().take(MAX_SPEAK_CHARS).collect()
    } else {
        trimmed.to_string()
    };
    let tok = token().ok_or_else(|| "Sign in to LingCode to use voice mode.".to_string())?;

    let url = format!("{}/api/voice/speak", api_base());
    let resp = client()?
        .post(&url)
        .bearer_auth(&tok)
        .json(&serde_json::json!({ "text": body_text }))
        .send()
        .await
        .map_err(|_| "Couldn't reach the voice service.".to_string())?;

    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();

    if !(200..300).contains(&status) {
        // On failure the server sends JSON, not audio.
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        return Err(voice_error_message(
            status,
            body.get("error").and_then(|v| v.as_str()).unwrap_or(""),
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|_| "The spoken reply didn't download.".to_string())?
        .to_vec();
    if bytes.is_empty() {
        return Err("The voice service returned no audio.".to_string());
    }
    Ok((bytes, content_type))
}

/// Map a server error code to something a person can act on. Deliberately never
/// surfaces a vendor name — the server already strips those, and this is the
/// second place that guarantee has to hold.
fn voice_error_message(status: u16, code: &str) -> String {
    match code {
        "unauthorized" => "Sign in to LingCode to use voice mode.".to_string(),
        "voice_not_configured" => "Voice mode isn't enabled on this server yet.".to_string(),
        "voice_rate_limited" => "Too much voice activity just now — wait a moment.".to_string(),
        "voice_service_unavailable" => "The voice service is unavailable right now.".to_string(),
        "unsupported_audio_type" => {
            "This system recorded an audio format the voice service can't read.".to_string()
        }
        "text_too_long" => "That reply was too long to speak.".to_string(),
        "empty_audio" => "Nothing was recorded — check the microphone.".to_string(),
        _ if status == 401 => "Sign in to LingCode to use voice mode.".to_string(),
        _ => "The voice request failed. Try again.".to_string(),
    }
}

/// Emit a risky-tool approval request to the webview so it can be spoken. The
/// webview answers with `voice_approve_resolve`.
pub fn emit_approval_request(app: &tauri::AppHandle, pending: &crate::approval::Pending) {
    let _ = app.emit("voice://approval-request", pending);
}

/// Answer a pending spoken approval. `allow` must come from a recognised
/// confirmation phrase, never from a bare "yes" — see voice.ts.
#[tauri::command]
pub fn voice_approve_resolve(
    state: tauri::State<'_, crate::VoiceApprovalHandle>,
    id: String,
    allow: bool,
) -> bool {
    state.resolve(&id, allow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_message_comes_from_the_fixed_set() {
        // An allow-list, not a block-list of vendor names: a block-list would
        // have to spell out the vendor in the source to test for it, which is
        // exactly what we're trying to avoid. This is also stronger — it fails
        // on ANY new message, including one that interpolates upstream text.
        let allowed = [
            "Sign in to LingCode to use voice mode.",
            "Voice mode isn't enabled on this server yet.",
            "Too much voice activity just now \u{2014} wait a moment.",
            "The voice service is unavailable right now.",
            "This system recorded an audio format the voice service can't read.",
            "That reply was too long to speak.",
            "Nothing was recorded \u{2014} check the microphone.",
            "The voice request failed. Try again.",
        ];
        let codes = ["unauthorized", "voice_not_configured", "voice_rate_limited",
                     "voice_service_unavailable", "unsupported_audio_type",
                     "text_too_long", "empty_audio", "something_unknown", ""];
        for c in codes {
            for st in [200u16, 401, 429, 500, 502] {
                let msg = voice_error_message(st, c);
                assert!(!msg.is_empty(), "empty message for {c}/{st}");
                assert!(
                    allowed.contains(&msg.as_str()),
                    "message for {c}/{st} is not in the fixed set: {msg:?}"
                );
            }
        }
    }

    #[test]
    fn speak_cap_matches_the_server() {
        // If these drift the server 413s and the user just hears nothing.
        assert_eq!(MAX_SPEAK_CHARS, 1200);
    }
}
