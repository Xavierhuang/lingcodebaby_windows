// Custom Anthropic-compatible endpoint config — Windows mirror of
// LingCodeBaby (Mac) src/LCBEndpointSheet.m + the customEndpoint* accessors
// in src/ClaudeChat.m.
//
// Storage split (matches Mac):
//   - URL + enable flag  →  prefs.json (via prefs.rs; not sensitive)
//   - API key            →  OS Keychain, service "LingCodeBaby",
//                           account "customEndpointAPIKey" (sensitive)
//
// Routing (see chat.rs): a configured endpoint (`use_custom_endpoint` on, URL
// and key set) appears as its own model-picker row, `TAG`. Picking that row
// gives the child `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`; every other row
// routes as usual. (It used to silently override every row.)

use keyring::Entry;
use serde::Serialize;

const SERVICE: &str = "LingCodeBaby";
const ACCOUNT: &str = "customEndpointAPIKey";

/// Model-picker tag for the custom endpoint row.
pub const TAG: &str = "custom";
/// Where a turn of the custom row goes when the endpoint is switched off.
const FALLBACK_MODEL: &str = "lingmodel";

/// The picker row's label: "Custom · api.example.com" plus the model when set.
pub fn row_label(url: &str, model: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let host = if host.is_empty() { "endpoint" } else { host };
    if model.is_empty() {
        format!("Custom · {host}")
    } else {
        format!("Custom · {host} ({model})")
    }
}

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
    pub model: String,
    /// Picker row text (`row_label`).
    pub label: String,
}

#[tauri::command]
pub fn endpoint_get_config() -> EndpointConfig {
    let prefs = crate::prefs::get_prefs();
    EndpointConfig {
        enabled: prefs.use_custom_endpoint,
        label: row_label(&prefs.custom_endpoint_url, &prefs.custom_endpoint_model),
        url: prefs.custom_endpoint_url,
        key_present: get_key().is_some(),
        model: prefs.custom_endpoint_model,
    }
}

/// Save (URL, key, enable). Trailing slash stripped from URL to match Mac.
/// If `key` is empty the existing stored key is kept (so the UI can send an
/// empty field to mean "don't change the key"); pass "\0" to force-delete.
/// Saving with `enabled` also selects the endpoint's picker row.
#[tauri::command]
pub fn endpoint_save_config(
    app: tauri::AppHandle,
    url: String,
    key: String,
    enabled: bool,
    model: Option<String>,
) -> Result<(), String> {
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
    if let Some(m) = model {
        prefs.custom_endpoint_model = m.trim().to_string();
    }
    prefs.use_custom_endpoint = enabled;
    if enabled {
        prefs.model = TAG.to_string();
    } else if prefs.model == TAG {
        prefs.model = FALLBACK_MODEL.to_string();
    }
    crate::prefs::set_prefs(prefs)?;
    crate::sync_custom_endpoint_row(&app);
    Ok(())
}

/// One-shot "Turn Off" button. Doesn't touch URL/key so the user can re-enable
/// later without re-typing.
/// The picker leaves the endpoint row, so a selected one falls back to LingModel.
#[tauri::command]
pub fn endpoint_disable(app: tauri::AppHandle) -> Result<(), String> {
    let mut prefs = crate::prefs::get_prefs();
    prefs.use_custom_endpoint = false;
    if prefs.model == TAG {
        prefs.model = FALLBACK_MODEL.to_string();
    }
    crate::prefs::set_prefs(prefs)?;
    crate::sync_custom_endpoint_row(&app);
    Ok(())
}

/// One-time move for installs where the endpoint overrode every row: put them
/// on the endpoint row so their turns keep going where they went before.
pub fn migrate_to_row() {
    let mut prefs = crate::prefs::get_prefs();
    if prefs.custom_endpoint_row_seen {
        return;
    }
    if is_active() {
        prefs.model = TAG.to_string();
    }
    prefs.custom_endpoint_row_seen = true;
    let _ = crate::prefs::set_prefs(prefs);
}

/// True when the picker is on the endpoint row and the endpoint is usable.
pub fn is_selected() -> bool {
    crate::prefs::get_prefs().model == TAG && is_active()
}

#[cfg(test)]
mod tests {
    use super::row_label;

    #[test]
    fn row_label_names_the_host() {
        assert_eq!(row_label("https://api.moonshot.ai/anthropic", ""), "Custom · api.moonshot.ai");
        assert_eq!(row_label("http://localhost:4000", "kimi-k2"), "Custom · localhost:4000 (kimi-k2)");
        assert_eq!(row_label("", ""), "Custom · endpoint");
    }
}

/// True iff a valid (URL + key) custom endpoint is active. Used by chat.rs
/// to route and by the onboarding gate to know the user is authenticated.
pub fn is_active() -> bool {
    let prefs = crate::prefs::get_prefs();
    prefs.use_custom_endpoint
        && !prefs.custom_endpoint_url.is_empty()
        && get_key().is_some()
}
