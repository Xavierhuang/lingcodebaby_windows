mod anthropic_key;
mod chat;
mod deploy;
mod endpoint;
mod fsops;
mod history;
mod prefs;
mod quinny;

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
    // Application menu — mirrors the Mac app menu (AppDelegate.setupMenu): the
    // auth-path items (API key, custom endpoint, sign out) live here rather than
    // under View, so the two platforms read the same.
    let app_menu = Submenu::with_items(
        app,
        "LingCodeBaby",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("LingCodeBaby"), None)?,
            &MenuItem::with_id(app, "welcome", "Welcome / Set Up…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "anthropic_key", "Set Anthropic API Key…", true, None::<&str>)?,
            &MenuItem::with_id(app, "custom_endpoint", "Custom Endpoint…", true, None::<&str>)?,
            &MenuItem::with_id(app, "sign_out", "Sign Out", true, None::<&str>)?,
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
            &MenuItem::with_id(app, "new_quinny_project", "New Quinny Project…", true, Some("CmdOrCtrl+Shift+N"))?,
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
    let m_lingmodel = mk_model("lingmodel", "LingModel — LingCode account")?;
    let m_default = mk_model("default", "Default (CLI / account)")?;
    let m_opus = mk_model("opus", "Opus — highest quality, highest cost")?;
    let m_sonnet = mk_model("sonnet", "Sonnet — balanced (recommended)")?;
    // Fable is on the Mac model list (AppDelegate.setupMenu); chat.rs maps the
    // alias to the real `claude-fable-5` id when it builds the CLI args.
    let m_fable = mk_model("fable", "Fable — Claude 5, fast")?;
    let m_haiku = mk_model("haiku", "Haiku — fastest, lowest cost")?;
    let model_menu = Submenu::with_items(
        app,
        "Claude Model",
        true,
        &[&m_lingmodel, &m_default, &m_opus, &m_sonnet, &m_fable, &m_haiku],
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
            // ⇧⌘K on Mac — clears the chat AND the saved history for the folder,
            // and starts a fresh CLI session.
            &MenuItem::with_id(app, "new_conversation", "New Conversation (Clear Chat)", true, Some("CmdOrCtrl+Shift+K"))?,
            &sounds,
            &PredefinedMenuItem::separator(app)?,
            &model_menu,
        ],
    )?;

    // LingCode Cloud menu — discoverable home for the managed backend (Postgres
    // + auth + storage + functions). The wiring otherwise happens silently when
    // a signed-in user sends a message; these items make it explicit. Mirrors
    // the Mac "LingCode Cloud" menu.
    let cloud_menu = Submenu::with_items(
        app,
        "LingCode Cloud",
        true,
        &[
            &MenuItem::with_id(app, "connect_backend", "Connect Backend to This Folder", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "backend_console", "Open Backend Console", true, None::<&str>)?,
        ],
    )?;

    // Help menu — parallels Mac's "LingCode Baby Help" (LCBHelpWindowController)
    // and "Visit lingcode.dev". The Welcome/onboarding entry lives in the app
    // menu, as it does on Mac.
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "help_window", "LingCodeBaby Help", true, Some("F1"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "visit_website", "Visit lingcode.dev", true, None::<&str>)?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &cloud_menu, &help_menu],
    )?;

    let mut models = HashMap::new();
    models.insert("lingmodel".to_string(), m_lingmodel);
    models.insert("default".to_string(), m_default);
    models.insert("opus".to_string(), m_opus);
    models.insert("sonnet".to_string(), m_sonnet);
    models.insert("fable".to_string(), m_fable);
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
    // Headless paths run before any window is created, so `--deploy` works from
    // a terminal or CI without flashing a GUI.
    if let Some(code) = deploy::run_cli() {
        std::process::exit(code);
    }
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
                "help_window" => {
                    // Open (or focus) the Help window — a secondary webview
                    // pointing at the bundled help.html. Mirrors Mac's
                    // LCBHelpWindowController showSupportWindow (singleton).
                    if let Some(w) = app.get_webview_window("help") {
                        let _ = w.set_focus();
                    } else {
                        let _ = WebviewWindowBuilder::new(app, "help", WebviewUrl::App("help.html".into()))
                            .title("LingCodeBaby Help")
                            .inner_size(820.0, 700.0)
                            .min_inner_size(480.0, 320.0)
                            .center()
                            .build();
                    }
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
            fsops::cloud_connect_backend,
            fsops::cloud_autoconnect_backend,
            prefs::get_prefs,
            prefs::set_prefs,
            chat::claude_send,
            chat::claude_abort,
            history::history_load,
            history::history_save,
            history::history_clear,
            history::attach_save,
            history::attach_remove,
            deploy::deploy_api_base,
            deploy::deploy_signin,
            deploy::deploy_load_config,
            deploy::deploy_save_config,
            deploy::deploy_get_saved_token,
            deploy::deploy_save_token,
            deploy::deploy_delete_token,
            deploy::deploy_slugify,
            deploy::deploy_has_index,
            deploy::deploy_check,
            deploy::deploy_upload,
            quinny::quinny_available,
            quinny::quinny_run,
            quinny::quinny_new_file,
            quinny::quinny_new_project,
            anthropic_key::anthropic_key_present,
            anthropic_key::anthropic_key_save,
            anthropic_key::anthropic_key_delete,
            endpoint::endpoint_get_config,
            endpoint::endpoint_save_config,
            endpoint::endpoint_disable,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
