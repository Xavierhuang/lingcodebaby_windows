// Personal Anthropic API key stored in the OS Keychain — Windows mirror of
// LingCodeBaby (Mac) src/LCBAnthropicKey.m. Kept in a separate Keychain entry
// from the LingCode account token (different vendor, different rotation) so
// signing out of LingModel doesn't nuke the fallback key, and vice-versa.
//
// Service/account match the Mac tree so a user syncing Keychain (e.g. iCloud
// on Mac, Credential Manager on Win) sees one consistent entry.

use keyring::Entry;

const SERVICE: &str = "LingCodeBaby";
const ACCOUNT: &str = "anthropic_api_key";

/// Read the stored key, preferring the process env var (dev override).
pub fn get() -> Option<String> {
    if let Ok(env) = std::env::var("ANTHROPIC_API_KEY") {
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

/// Save (empty string = delete). Mirrors LCBAnthropicKey setApiKey: which
/// SecItemDelete + SecItemAdd (never leaves a partial state).
pub fn save(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        // "Clear the stored key" per Mac convention.
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(trimmed).map_err(|e| e.to_string())
}

// ---- Tauri commands ---------------------------------------------------------

/// UI wants to know whether the fallback key is configured (so the model
/// picker / onboarding gate can enable a "personal Anthropic key" path).
#[tauri::command]
pub fn anthropic_key_present() -> bool {
    get().is_some()
}

#[tauri::command]
pub fn anthropic_key_save(key: String) -> Result<(), String> {
    save(&key)
}

#[tauri::command]
pub fn anthropic_key_delete() -> Result<(), String> {
    save("")
}
