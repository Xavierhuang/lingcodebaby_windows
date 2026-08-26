// Guiding the user through installing the Claude Code CLI — Windows/Linux mirror
// of Mac LingCodeBaby `+[ClaudeChat beginClaudeInstall]` (src/ClaudeChat.m).
//
// The app never bundles an engine: every turn shells out to the user's installed
// `claude` (chat.rs `claude_send`). Without it the chat input is dead, so both
// the onboarding gate and a one-shot launch prompt offer to install it. The
// frontend's dialog is the consent step; by the time we're called the user has
// agreed to let the official installer run, so we run it rather than making them
// paste it. If no terminal can be launched we report that and the frontend falls
// back to showing + copying the command, exactly like the Mac fallback.

/// Which installer to run. `native` is Anthropic's own installer (no Node
/// needed); `npm` is the global-package fallback for machines that already have
/// Node but can't run the installer script.
fn install_command(method: &str) -> Result<String, String> {
    let npm = "npm install -g @anthropic-ai/claude-code";
    match method {
        "npm" => Ok(npm.to_string()),
        #[cfg(target_os = "windows")]
        "native" => Ok("irm https://claude.ai/install.ps1 | iex".to_string()),
        #[cfg(not(target_os = "windows"))]
        "native" => Ok("curl -fsSL https://claude.ai/install.sh | bash".to_string()),
        other => Err(format!("Unknown install method: {other}")),
    }
}

/// The command `claude_install` would run, so the frontend can show it to the
/// user (and copy it) when we couldn't open a terminal ourselves.
#[tauri::command]
pub fn claude_install_command(method: String) -> Result<String, String> {
    install_command(&method)
}

/// Is the `claude` CLI resolvable right now? Mirrors Mac `-isClaudeAvailable`.
#[tauri::command]
pub fn claude_available() -> bool {
    crate::chat::find_claude().is_some()
}

/// Open a terminal running the chosen installer. `Ok(true)` — it's running;
/// `Ok(false)` — no terminal could be launched, so the caller should show the
/// command for manual copying. `Err` only for an unknown `method`.
#[tauri::command]
pub fn claude_install(method: String) -> Result<bool, String> {
    let cmd = install_command(&method)?;
    Ok(spawn_in_terminal(&cmd))
}

#[cfg(target_os = "windows")]
fn spawn_in_terminal(cmd: &str) -> bool {
    // `start` needs a title argument first, otherwise it swallows the next
    // quoted token as the window title. -NoExit keeps the window up so the user
    // can read the installer's output (and any failure) instead of it vanishing.
    std::process::Command::new("cmd")
        .args([
            "/C",
            "start",
            "Install Claude Code",
            "powershell",
            "-NoExit",
            "-Command",
            cmd,
        ])
        .spawn()
        .is_ok()
}

#[cfg(target_os = "macos")]
fn spawn_in_terminal(cmd: &str) -> bool {
    // Same AppleScript route the Mac tree takes, so both trees behave alike.
    // AppleScript string literals escape backslash and double-quote only.
    let escaped = cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("tell application \"Terminal\"\nactivate\ndo script \"{escaped}\"\nend tell");
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn()
        .is_ok()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_in_terminal(cmd: &str) -> bool {
    // Keep the shell alive after the installer exits for the same reason as
    // -NoExit above: the user needs to see what happened.
    let keep_open = format!("{cmd}; echo; echo 'Press Enter to close.'; read _");
    // gnome-terminal's `-e` takes a single string and is deprecated; `--` is the
    // argv form. The others accept `-e` followed by argv.
    for (term, flag) in [
        ("x-terminal-emulator", "-e"),
        ("gnome-terminal", "--"),
        ("konsole", "-e"),
        ("xterm", "-e"),
    ] {
        if std::process::Command::new(term)
            .args([flag, "sh", "-c", keep_open.as_str()])
            .spawn()
            .is_ok()
        {
            return true;
        }
    }
    false
}
