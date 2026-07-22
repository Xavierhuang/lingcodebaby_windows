// Custom Anthropic-compatible endpoint config sheet — Windows mirror of
// LingCodeBaby (Mac) src/LCBEndpointSheet.m. Modal with URL + API key +
// Save / Turn Off / Cancel. Key body is never echoed back into the DOM after
// save; the input starts empty and the sheet shows "•••• stored" when a key
// is already in the Keychain.
//
// Storage lives in endpoint.rs (URL in prefs.json, key in Keychain).

import { api } from "./api";

const OVERLAY_CLASS = "modal-overlay";

/** Open the custom-endpoint sheet. Resolves when it closes. */
export async function showEndpointSheet(): Promise<void> {
  const cfg = await api.endpointGetConfig();

  return new Promise<void>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = OVERLAY_CLASS;
    overlay.innerHTML = `
      <div class="modal endpoint-sheet">
        <div class="modal-title">Custom Endpoint</div>
        <div class="endpoint-desc">
          Point LingCodeBaby at a custom Anthropic-compatible endpoint —
          Anthropic, Moonshot Kimi, DeepSeek, LiteLLM, OpenRouter, etc.
        </div>
        <div class="endpoint-hint">
          The endpoint must accept <code>/v1/messages</code> with an
          <code>x-api-key</code> header. This overrides Claude subscription
          and LingModel.
        </div>
        <label class="endpoint-row">
          <span class="endpoint-label">Base URL</span>
          <input class="endpoint-url" type="url" placeholder="https://api.anthropic.com">
        </label>
        <label class="endpoint-row">
          <span class="endpoint-label">API Key</span>
          <input class="endpoint-key" type="password" placeholder="sk-ant-… (leave empty to keep the stored key)">
        </label>
        <div class="endpoint-key-status"></div>
        <div class="endpoint-error" role="alert"></div>
        <div class="modal-buttons endpoint-buttons">
          <button class="endpoint-off">Turn Off</button>
          <span class="spacer" style="flex:1"></span>
          <button class="endpoint-cancel">Cancel</button>
          <button class="endpoint-save modal-ok">Save &amp; Enable</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const urlIn  = overlay.querySelector<HTMLInputElement>(".endpoint-url")!;
    const keyIn  = overlay.querySelector<HTMLInputElement>(".endpoint-key")!;
    const status = overlay.querySelector<HTMLElement>(".endpoint-key-status")!;
    const errEl  = overlay.querySelector<HTMLElement>(".endpoint-error")!;
    const saveBn = overlay.querySelector<HTMLButtonElement>(".endpoint-save")!;
    const offBn  = overlay.querySelector<HTMLButtonElement>(".endpoint-off")!;
    const cxBn   = overlay.querySelector<HTMLButtonElement>(".endpoint-cancel")!;

    urlIn.value = cfg.url;
    status.textContent = cfg.key_present
      ? "•••• stored (leave blank to keep it)"
      : "no key stored yet";
    if (!cfg.enabled) {
      offBn.disabled = true;
    }
    urlIn.focus();

    const close = () => { overlay.remove(); resolve(); };
    cxBn.onclick = close;
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });

    offBn.onclick = async () => {
      try {
        await api.endpointDisable();
        close();
      } catch (e) {
        errEl.textContent = String(e);
      }
    };

    saveBn.onclick = async () => {
      errEl.textContent = "";
      const url = urlIn.value.trim();
      const key = keyIn.value; // don't trim — some providers accept whitespace-bearing keys
      if (!url) {
        errEl.textContent = "Base URL is required.";
        return;
      }
      try {
        await api.endpointSaveConfig(url, key, true);
        close();
      } catch (e) {
        errEl.textContent = String(e);
      }
    };
  });
}
