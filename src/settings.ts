// The gear in the top bar. Homes for what the native View/App menus also
// offer, so a user who never opens a menu can still find them.
import { Appearance } from "./theme";

export interface SettingsState {
  appearance: Appearance;
  playSounds: boolean;
  showAllSteps: boolean;
  remoteAccess: boolean;
  remoteStatus: string;
}

export interface SettingsActions {
  onAppearance: (a: Appearance) => void;
  onSounds: (on: boolean) => void;
  onShowAllSteps: (on: boolean) => void;
  onRemoteAccess: (on: boolean) => void;
  anthropicKey: () => Promise<void>;
  deepseekKey: () => Promise<void>;
  customEndpoint: () => Promise<void>;
  signOut: () => Promise<void>;
  checkUpdates: () => Promise<void>;
  welcome: () => Promise<void>;
}

export function showSettings(state: SettingsState, actions: SettingsActions): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal settings-sheet">
        <div class="modal-title">Settings</div>
        <div class="settings-row"><span class="k">Appearance</span>
          <select class="field appearance"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
        <div class="settings-row"><span class="k">Sounds</span><label><input type="checkbox" class="sounds"/> Chime when Claude finishes or asks</label></div>
        <div class="settings-row"><span class="k">Transcript</span><label><input type="checkbox" class="steps"/> Show all steps (every command and edit)</label></div>
        <div class="settings-row"><span class="k">Remote access</span><label><input type="checkbox" class="remote"/> Chat with this PC's agent from lingcode.dev/remote</label></div>
        <div class="settings-row"><span class="k"></span><span class="faint remote-status"></span></div>
        <div class="settings-actions">
          <button class="btn sm" data-act="anthropic">Anthropic API key…</button>
          <button class="btn sm" data-act="deepseek">DeepSeek API key…</button>
          <button class="btn sm" data-act="endpoint">Custom endpoint…</button>
          <button class="btn sm" data-act="updates">Check for updates</button>
          <button class="btn sm" data-act="welcome">Welcome tour</button>
          <button class="btn sm" data-act="signout">Sign out</button>
        </div>
        <div class="modal-buttons"><button class="modal-ok">Done</button></div>
      </div>`;
    const sel = overlay.querySelector(".appearance") as HTMLSelectElement;
    const sounds = overlay.querySelector(".sounds") as HTMLInputElement;
    const steps = overlay.querySelector(".steps") as HTMLInputElement;
    sel.value = state.appearance;
    sounds.checked = state.playSounds;
    steps.checked = state.showAllSteps;
    sel.onchange = () => actions.onAppearance(sel.value as Appearance);
    sounds.onchange = () => actions.onSounds(sounds.checked);
    steps.onchange = () => actions.onShowAllSteps(steps.checked);
    const remote = overlay.querySelector(".remote") as HTMLInputElement;
    const remoteStatus = overlay.querySelector(".remote-status") as HTMLElement;
    remote.checked = state.remoteAccess;
    remoteStatus.textContent = state.remoteAccess ? state.remoteStatus : "Off. Signed in to LingCode, you can open lingcode.dev/remote on your phone and chat with this PC.";
    remote.onchange = () => {
      actions.onRemoteAccess(remote.checked);
      remoteStatus.textContent = remote.checked ? "Connecting…" : "Off";
    };
    const close = () => { overlay.remove(); resolve(); };
    const run = async (fn: () => Promise<void>) => { close(); await fn(); };
    overlay.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
      b.onclick = () => {
        switch (b.dataset.act) {
          case "anthropic": return run(actions.anthropicKey);
          case "deepseek": return run(actions.deepseekKey);
          case "endpoint": return run(actions.customEndpoint);
          case "updates": return run(actions.checkUpdates);
          case "welcome": return run(actions.welcome);
          case "signout": return run(actions.signOut);
        }
        return undefined;
      };
    });
    (overlay.querySelector(".modal-ok") as HTMLButtonElement).onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  });
}
