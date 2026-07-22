// Custom Anthropic-compatible endpoint config — Windows mirror of
// LingCodeBaby (Mac) src/LCBEndpointSheet.m + the customEndpoint* accessors
// in src/ClaudeChat.m.
//
// Storage split (matches Mac):
//   - URL + enable flag  →  prefs.json (via prefs.rs; not sensitive)
//   - API key            →  OS Keychain, service "LingCodeBaby",
//                           account "customEndpointAPIKey" (sensitive)
//
// Routing (see chat.rs): if `use_custom_endpoint` is on and both URL and key
// are set, the child inherits `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` and
// LingModel / subscription are suppressed. This overrides everything else.

use keyring::Entry;
use serde::Serialize;

const SERVICE: &str = "LingCodeBaby";
const ACCOUNT: &str = "customEndpointAPIKey";

/// Read the stored custom-endpoint API key. Not env-backed — this must
/// come from the config sheet the user filled in.
pub fn get_key() -> Option<String> {
    let entry = Entry::new(SERVICE, ACCOUNT).ok()?;
    let raw = entry.get_password().ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

fn save_key(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(trimmed).map_err(|e| e.to_string())
}

/// Shape returned to the UI. Never includes the key body — only whether one
/// is set — so the config sheet can preserve state without echoing the
/// secret into the DOM.
#[derive(Serialize)]
pub struct EndpointConfig {
    pub enabled: bool,
    pub url: String,
    pub key_present: bool,
}

#[tauri::command]
pub fn endpoint_get_config() -> EndpointConfig {
    let prefs = crate::prefs::get_prefs();
    EndpointConfig {
        enabled: prefs.use_custom_endpoint,
        url: prefs.custom_endpoint_url,
        key_present: get_key().is_some(),
    }
}

/// Save (URL, key, enable). Trailing slash stripped from URL to match Mac.
/// If `key` is empty the existing stored key is kept (so the UI can send an
/// empty field to mean "don't change the key"); pass "\0" to force-delete.
#[tauri::command]
pub fn endpoint_save_config(url: String, key: String, enabled: bool) -> Result<(), String> {
    let mut url = url.trim().to_string();
    if url.ends_with('/') {
        url.pop();
    }
    if enabled {
        // A save that turns the endpoint ON must have both fields — one or
        // the other alone would silently route to a broken endpoint.
        if url.is_empty() {
            return Err("Base URL is required.".into());
        }
        // key: empty = keep the existing one; "\0" = force delete.
        if key == "\0" {
            save_key("")?;
            return Err("A key must be set before enabling the custom endpoint.".into());
        }
        if !key.is_empty() {
            save_key(&key)?;
        } else if get_key().is_none() {
            return Err("API key is required.".into());
        }
    } else {
        // Turning off — still persist any URL/key change so the sheet
        // remembers them for next time.
        if key == "\0" {
            save_key("")?;
        } else if !key.is_empty() {
            save_key(&key)?;
        }
    }
    let mut prefs = crate::prefs::get_prefs();
    prefs.custom_endpoint_url = url;
    prefs.use_custom_endpoint = enabled;
    crate::prefs::set_prefs(prefs)
}

/// One-shot "Turn Off" button. Doesn't touch URL/key so the user can re-enable
/// later without re-typing.
#[tauri::command]
pub fn endpoint_disable() -> Result<(), String> {
    let mut prefs = crate::prefs::get_prefs();
    prefs.use_custom_endpoint = false;
    crate::prefs::set_prefs(prefs)
}

/// True iff a valid (URL + key) custom endpoint is active. Used by chat.rs
/// to route and by the onboarding gate to know the user is authenticated.
pub fn is_active() -> bool {
    let prefs = crate::prefs::get_prefs();
    prefs.use_custom_endpoint
        && !prefs.custom_endpoint_url.is_empty()
        && get_key().is_some()
}
