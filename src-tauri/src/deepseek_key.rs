// DeepSeek rows in the model menu — Windows mirror of LingCodeBaby (Mac)
// src/LCBDeepSeek.m. Baby runs the user's own `claude` CLI; a DeepSeek row
// points it at DeepSeek's Anthropic-compatible endpoint with the user's
// DeepSeek key, the same environment LingCode's Claude Code tab sets for these
// rows. claude 2.1.270 prints an `unrecognized_model` warning line for the id
// but still sends it (checked on the Mac 2026-09-14); chat.rs skips non-JSON
// stdout lines already.
//
// The key lives in its own Keychain entry beside the Anthropic key: a
// different vendor's secret, rotated on its own schedule. Service/account
// match the Mac tree.

use keyring::Entry;

const SERVICE: &str = "LingCodeBaby";
const ACCOUNT: &str = "deepseek_api_key";

/// DeepSeek's Anthropic-compatible endpoint. Both rows share it; the model id
/// travels as `--model`.
pub(crate) const BASE_URL: &str = "https://api.deepseek.com/anthropic";

/// Model menu rows as (tag, label), in menu order. The tag is the DeepSeek
/// model id the CLI passes through unchanged.
pub(crate) const MENU_ROWS: &[(&str, &str)] = &[
    ("deepseek-v4-pro", "DeepSeek V4 Pro — needs a DeepSeek API key"),
    ("deepseek-v4-flash", "DeepSeek V4 Flash — fast, low cost"),
];

/// Whether `model` (a picker tag) is one of the DeepSeek rows.
pub(crate) fn is_deepseek_model(model: &str) -> bool {
    MENU_ROWS.iter().any(|(tag, _)| *tag == model)
}

/// What the user sees when a DeepSeek row is chosen with no key stored.
/// Wording mirrors LCBDeepSeek.m so support answers apply to both apps.
pub(crate) const NO_KEY_MESSAGE: &str =
    "DeepSeek needs your API key. Choose LingCodeBaby → Set DeepSeek API Key…, paste a key from platform.deepseek.com, then send again.";

/// Read the stored key, preferring the process env var (dev override).
pub fn get() -> Option<String> {
    if let Ok(env) = std::env::var("DEEPSEEK_API_KEY") {
        let t = env.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    let entry = Entry::new(SERVICE, ACCOUNT).ok()?;
    let raw = entry.get_password().ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

/// Save (empty string = delete). Same delete-then-set shape as anthropic_key.
pub fn save(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(trimmed).map_err(|e| e.to_string())
}

// ---- Tauri commands ---------------------------------------------------------

#[tauri::command]
pub fn deepseek_key_present() -> bool {
    get().is_some()
}

#[tauri::command]
pub fn deepseek_key_save(key: String) -> Result<(), String> {
    save(&key)
}

#[tauri::command]
pub fn deepseek_key_delete() -> Result<(), String> {
    save("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_only_the_menu_rows() {
        assert!(is_deepseek_model("deepseek-v4-pro"));
        assert!(is_deepseek_model("deepseek-v4-flash"));
        assert!(!is_deepseek_model("deepseek"));
        assert!(!is_deepseek_model("opus"));
        assert!(!is_deepseek_model("lingmodel"));
    }
}
