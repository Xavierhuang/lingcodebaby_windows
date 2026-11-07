// The gear in the top bar. Homes for what the native View/App menus also
// offer, so a user who never opens a menu can still find them.
import { Appearance } from "./theme";
import type { CodexModel } from "./api";

export interface SettingsState {
  appearance: Appearance;
  playSounds: boolean;
  showAllSteps: boolean;
  remoteAccess: boolean;
  remoteStatus: string;
  codexModel: string;
  codexEffort: string;
}

export interface SettingsActions {
  onAppearance: (a: Appearance) => void;
  onSounds: (on: boolean) => void;
  onShowAllSteps: (on: boolean) => void;
  onRemoteAccess: (on: boolean) => void;
  onCodex: (model: string, effort: string) => void;
  codexModels: () => Promise<CodexModel[]>;
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
        <div class="settings-row"><span class="k">Version</span><span>LingCodeBaby ${__APP_VERSION__}</span></div>
        <div class="settings-row"><span class="k">Appearance</span>
          <select class="field appearance"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
        <div class="settings-row"><span class="k">Sounds</span><label><input type="checkbox" class="sounds"/> Chime when Claude finishes or asks</label></div>
        <div class="settings-row"><span class="k">Transcript</span><label><input type="checkbox" class="steps"/> Keep steps expanded after a turn</label></div>
        <div class="settings-row"><span class="k">Remote access</span><label><input type="checkbox" class="remote"/> Chat with this PC's agent from lingcode.dev/remote</label></div>
        <div class="settings-row"><span class="k"></span><span class="faint remote-status"></span></div>
        <div class="settings-row"><span class="k">Codex model</span>
          <select class="field codex-model" disabled><option value="">Loading…</option></select>
          <select class="field codex-effort" disabled><option value="">Default effort</option></select></div>
        <div class="settings-row"><span class="k"></span><span class="faint codex-note"></span></div>
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
    // Codex: the models this PC's Codex offers, and each one's effort levels.
    const cModel = overlay.querySelector(".codex-model") as HTMLSelectElement;
    const cEffort = overlay.querySelector(".codex-effort") as HTMLSelectElement;
    const cNote = overlay.querySelector(".codex-note") as HTMLElement;
    let models: CodexModel[] = [];
    const option = (value: string, label: string) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      return o;
    };
    const fillEfforts = (keep: string) => {
      const m = models.find((x) => x.slug === cModel.value);
      cEffort.replaceChildren(option("", m?.default_effort ? `Default effort (${m.default_effort})` : "Default effort"));
      for (const e of m?.efforts ?? ["low", "medium", "high"]) cEffort.appendChild(option(e, e[0].toUpperCase() + e.slice(1)));
      cEffort.value = [...cEffort.options].some((o) => o.value === keep) ? keep : "";
      cNote.textContent = m ? m.description : "Uses whatever Codex is set to on this PC.";
    };
    void actions.codexModels().then(
      (list) => {
        models = list;
        cModel.replaceChildren(option("", "Codex default"), ...list.map((m) => option(m.slug, m.name)));
        // A saved model this Codex no longer lists still shows, so it isn't lost silently.
        if (state.codexModel && !list.some((m) => m.slug === state.codexModel)) {
          cModel.appendChild(option(state.codexModel, `${state.codexModel} (not listed)`));
        }
        cModel.value = state.codexModel;
        cModel.disabled = cEffort.disabled = false;
        fillEfforts(state.codexEffort);
      },
      (err) => {
        cModel.replaceChildren(option("", "Codex not available"));
        cNote.textContent = String(err);
      },
    );
    cModel.onchange = () => { fillEfforts(cEffort.value); actions.onCodex(cModel.value, cEffort.value); };
    cEffort.onchange = () => actions.onCodex(cModel.value, cEffort.value);
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
