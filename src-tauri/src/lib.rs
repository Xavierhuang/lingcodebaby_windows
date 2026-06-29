mod chat;
mod deploy;
mod fsops;
mod prefs;

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

/// Toggleable menu items we need to keep references to so we can reflect state.
struct MenuState {
    thinking: CheckMenuItem<Wry>,
    sounds: CheckMenuItem<Wry>,
    models: HashMap<String, CheckMenuItem<Wry>>,
    window_count: AtomicUsize,
}

fn build_menu(app: &tauri::AppHandle, prefs: &prefs::Prefs) -> tauri::Result<(Menu<Wry>, MenuState)> {
    // Application menu
    let app_menu = Submenu::with_items(
        app,
        "LingCodeBaby",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("LingCodeBaby"), None)?,
            &MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // File menu
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new_window", "New Window", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "open_file", "Open…", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(app, "open_folder", "Open Folder…", true, Some("CmdOrCtrl+Shift+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "deploy", "Deploy to LingCode Cloud", true, Some("CmdOrCtrl+Shift+D"))?,
        ],
    )?;

    // Edit menu — native editing actions + find passthrough.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "find", "Find…", true, Some("CmdOrCtrl+F"))?,
            &MenuItem::with_id(app, "find_next", "Find Next", true, Some("CmdOrCtrl+G"))?,
            &MenuItem::with_id(app, "find_prev", "Find Previous", true, Some("CmdOrCtrl+Shift+G"))?,
        ],
    )?;

    // Claude Model submenu (radio-like).
    let mk_model = |id: &str, label: &str| -> tauri::Result<CheckMenuItem<Wry>> {
        CheckMenuItem::with_id(app, format!("model:{id}"), label, true, prefs.model == id, None::<&str>)
    };
    let m_default = mk_model("default", "Default (CLI / account)")?;
    let m_opus = mk_model("opus", "Opus — highest quality")?;
    let m_sonnet = mk_model("sonnet", "Sonnet — balanced (recommended)")?;
    let m_haiku = mk_model("haiku", "Haiku — fastest")?;
    let model_menu = Submenu::with_items(
        app,
        "Claude Model",
        true,
        &[&m_default, &m_opus, &m_sonnet, &m_haiku],
    )?;

    let thinking = CheckMenuItem::with_id(app, "toggle_thinking", "Show Claude Thinking", true, false, Some("CmdOrCtrl+Shift+T"))?;
    let stop = MenuItem::with_id(app, "stop_claude", "Stop Claude", true, Some("CmdOrCtrl+."))?;
    let sounds = CheckMenuItem::with_id(app, "toggle_sounds", "Play Sounds", true, prefs.play_sounds, None::<&str>)?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &thinking,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &sounds,
            &PredefinedMenuItem::separator(app)?,
            &model_menu,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu])?;

    let mut models = HashMap::new();
    models.insert("default".to_string(), m_default);
    models.insert("opus".to_string(), m_opus);
    models.insert("sonnet".to_string(), m_sonnet);
    models.insert("haiku".to_string(), m_haiku);

    Ok((
        menu,
        MenuState { thinking, sounds, models, window_count: AtomicUsize::new(0) },
    ))
}

/// Deliver a menu command only to the currently focused window, so menu actions
/// don't fan out to every open window. Falls back to a global emit.
fn emit_focused(app: &tauri::AppHandle, payload: String) {
    let target = app
        .webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label);
    match target {
        Some(label) => {
            let _ = app.emit_to(label, "menu", payload);
        }
        None => {
            let _ = app.emit("menu", payload);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(chat::ChatState::default())
        .setup(|app| {
            let prefs = prefs::get_prefs();
            let (menu, menu_state) = build_menu(app.handle(), &prefs)?;
            app.set_menu(menu)?;
            app.manage(menu_state);
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            let state = app.state::<MenuState>();

            if let Some(model) = id.strip_prefix("model:") {
                // Radio behaviour: check the chosen model, uncheck the rest.
                for (key, item) in state.models.iter() {
                    let _ = item.set_checked(key == model);
                }
                emit_focused(app, format!("model:{model}"));
                return;
            }

            match id.as_str() {
                "toggle_thinking" => {
                    let now = state.thinking.is_checked().unwrap_or(false);
                    emit_focused(app, (if now { "thinking:on" } else { "thinking:off" }).into());
                }
                "toggle_sounds" => {
                    let now = state.sounds.is_checked().unwrap_or(true);
                    emit_focused(app, (if now { "sounds:on" } else { "sounds:off" }).into());
                }
                "new_window" => {
                    let n = state.window_count.fetch_add(1, Ordering::SeqCst) + 1;
                    let label = format!("win-{n}");
                    let _ = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
                        .title("LingCodeBaby")
                        .inner_size(1040.0, 680.0)
                        .center()
                        .build();
                }
                other => {
                    emit_focused(app, other.to_string());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            fsops::list_dir,
            fsops::read_text_file,
            fsops::write_text_file,
            fsops::create_file,
            fsops::create_dir,
            fsops::rename_path,
            fsops::trash_path,
            fsops::reveal_in_explorer,
            fsops::scaffold_agent_files,
            prefs::get_prefs,
            prefs::set_prefs,
            chat::claude_send,
            chat::claude_abort,
            deploy::deploy_api_base,
            deploy::deploy_signin,
            deploy::deploy_load_config,
            deploy::deploy_save_config,
            deploy::deploy_get_saved_token,
            deploy::deploy_save_token,
            deploy::deploy_slugify,
            deploy::deploy_has_index,
            deploy::deploy_check,
            deploy::deploy_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
