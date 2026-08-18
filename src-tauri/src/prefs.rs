// Persistent user preferences (Claude model, sound toggle, appearance), the
// cross-platform stand-in for NSUserDefaults. Stored as JSON in the OS app-config
// directory.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Follow the OS unless the user says otherwise.
fn default_appearance() -> String {
    "system".to_string()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Prefs {
    pub model: String,       // "lingmodel" | "default" | "opus" | "sonnet" | "fable" | "haiku"
    pub play_sounds: bool,
    /// Custom endpoint state — the API key itself is in the OS Keychain
    /// (endpoint.rs), never in this JSON. Mirrors Mac ClaudeChat.m's
    /// `LCB.customEndpointURL` NSUserDefaults key + `useCustomEndpoint`.
    #[serde(default)]
    pub use_custom_endpoint: bool,
    #[serde(default)]
    pub custom_endpoint_url: String,
    /// Sticky flag set once the user has cleared the first-run onboarding
    /// gate. `false` on a fresh install → gate is shown on launch. Mirrors
    /// LCBOnboarding's "shown once" NSUserDefaults flag.
    #[serde(default)]
    pub onboarding_complete: bool,
    /// "system" (follow the OS) | "light" | "dark". Windows apps are expected to
    /// offer per-app theme control; the Mac app only follows the OS appearance,
    /// so this is deliberately beyond parity.
    #[serde(default = "default_appearance")]
    pub appearance: String,
}

impl Default for Prefs {
    fn default() -> Self {
        // Fresh installs default to LingModel (LingCode account, no personal
        // Claude subscription needed); sounds on. Existing users keep their
        // saved pref in prefs.json.
        Prefs {
            model: "lingmodel".into(),
            play_sounds: true,
            use_custom_endpoint: false,
            custom_endpoint_url: String::new(),
            onboarding_complete: false,
            appearance: default_appearance(),
        }
    }
}

fn prefs_path() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("com.lingcodebaby.app");
    let _ = std::fs::create_dir_all(&dir);
    dir.push("prefs.json");
    dir
}

#[tauri::command]
pub fn get_prefs() -> Prefs {
    match std::fs::read(prefs_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Prefs::default(),
    }
}

#[tauri::command]
pub fn set_prefs(prefs: Prefs) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&prefs).map_err(|e| e.to_string())?;
    std::fs::write(prefs_path(), bytes).map_err(|e| e.to_string())
}
