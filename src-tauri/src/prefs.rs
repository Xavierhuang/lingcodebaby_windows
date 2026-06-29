// Persistent user preferences (Claude model + sound toggle), the cross-platform
// stand-in for NSUserDefaults. Stored as JSON in the OS app-config directory.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
pub struct Prefs {
    pub model: String,       // "default" | "opus" | "sonnet" | "haiku"
    pub play_sounds: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        // Defaults match the original app: Sonnet, sounds on.
        Prefs { model: "sonnet".into(), play_sounds: true }
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
