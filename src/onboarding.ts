// First-run onboarding gate — Windows mirror of LingCodeBaby (Mac)
// src/LCBOnboarding.m. Shows a "connect what you need" card the first time
// the app launches (or from Help → Welcome…). Three auth paths, matching Mac:
//   1. LingModel — sign in to the LingCode account (default; no personal key)
//   2. Custom endpoint — BYO Anthropic-compatible URL + API key
//   3. Personal Anthropic key — paste into Keychain
// A fourth implicit path ("use my Claude subscription") is always available
// via a "Skip for now" button — Claude Code CLI handles that itself.
//
// The gate marks `onboarding_complete=true` in prefs.json on any path chosen,
// so it never re-appears unless the user picks Help → Welcome… explicitly.

import { api, type ClaudeInstallMethod } from "./api";
import { showEndpointSheet } from "./endpoint";
import { tokenPrompt, alertDialog, promptText } from "./ui";

/** Run the Claude Code installer in a terminal. When no terminal could be
 *  launched, fall back to the Mac behaviour: put the command on the clipboard
 *  so the user can paste it themselves. Returns what to tell them. */
export async function runClaudeInstall(
  method: ClaudeInstallMethod,
): Promise<{ running: boolean; command: string }> {
  const [running, command] = await Promise.all([
    api.claudeInstall(method),
    api.claudeInstallCommand(method),
  ]);
  if (!running) {
    try { await navigator.clipboard.writeText(command); } catch { /* best effort */ }
  }
  return { running, command };
}

/** Returns true iff SOMEthing is configured that lets the app talk to a model. */
async function isAuthenticated(): Promise<boolean> {
  const [tok, key, ep] = await Promise.all([
    api.deployGetSavedToken(),
    api.anthropicKeyPresent(),
    api.endpointGetConfig(),
  ]);
  return !!tok || key || (ep.enabled && ep.key_present);
}

async function markComplete() {
  try {
    const prefs = await api.getPrefs();
    await api.setPrefs({ ...prefs, onboarding_complete: true });
  } catch { /* non-fatal */ }
}

/** Show the onboarding card. `hardGate=true` disables the "Skip" button so
 *  the app cannot be reached until an auth path is chosen (used on first
 *  launch when nothing at all is configured). */
export async function showOnboarding(hardGate: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay onboarding-overlay";
    overlay.innerHTML = `
      <div class="modal onboarding">
        <div class="onboarding-title">Welcome to LingCodeBaby</div>
        <div class="onboarding-sub">
          A tiny cross-platform editor with Claude, cloud deploy, and Quinny
          built in. Pick how you want to talk to Claude — you can change any
          time from the View menu.
        </div>

        <div class="onboarding-cli-row" hidden>
          <div class="onboarding-cli-text">
            <div class="onboarding-cli-title">Claude Code CLI</div>
            <div class="onboarding-cli-body">
              The engine LingCodeBaby runs on — not installed on this machine yet.
            </div>
          </div>
          <div class="onboarding-cli-actions">
            <button class="onboarding-cli-btn primary" data-method="native">Install</button>
            <button class="onboarding-cli-btn" data-method="npm">via npm</button>
          </div>
        </div>

        <div class="onboarding-cards">
          <button class="onboarding-card" data-choice="lingmodel">
            <div class="onboarding-card-title">LingModel account</div>
            <div class="onboarding-card-body">
              Sign in with your LingCode account. No personal Claude
              subscription or API key needed. Recommended.
            </div>
          </button>
          <button class="onboarding-card" data-choice="subscription">
            <div class="onboarding-card-title">Claude subscription</div>
            <div class="onboarding-card-body">
              Use the account behind <code>claude login</code> in your
              terminal (Pro / Team / etc.). Nothing to configure here.
            </div>
          </button>
          <button class="onboarding-card" data-choice="endpoint">
            <div class="onboarding-card-title">Custom endpoint</div>
            <div class="onboarding-card-body">
              BYO Anthropic-compatible URL and key — Anthropic direct,
              Moonshot Kimi, DeepSeek, LiteLLM, OpenRouter.
            </div>
          </button>
          <button class="onboarding-card" data-choice="anthropic">
            <div class="onboarding-card-title">Personal Anthropic key</div>
            <div class="onboarding-card-body">
              Paste a personal <code>sk-ant-…</code> key into the OS
              Keychain. Fallback used when nothing else is configured.
            </div>
          </button>
        </div>

        <div class="onboarding-error" role="alert"></div>
        <div class="modal-buttons onboarding-buttons">
          <button class="onboarding-skip" ${hardGate ? "disabled title='Choose an auth path first — the gate is a hard requirement on first launch.'" : ""}>
            ${hardGate ? "Choose a path above" : "Skip for now"}
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const errEl = overlay.querySelector<HTMLElement>(".onboarding-error")!;
    const skip  = overlay.querySelector<HTMLButtonElement>(".onboarding-skip")!;

    // Engine row — only shown when the CLI is actually missing. It deliberately
    // does NOT gate finish(): the auth cards still decide when the gate closes,
    // so a user who installs the CLI out-of-band is never trapped here.
    const cliRow = overlay.querySelector<HTMLElement>(".onboarding-cli-row")!;
    api.claudeAvailable().then((present) => { cliRow.hidden = present; }).catch(() => {});
    cliRow.querySelectorAll<HTMLButtonElement>(".onboarding-cli-btn").forEach((btn) => {
      btn.onclick = async () => {
        const method = btn.dataset.method as ClaudeInstallMethod;
        const actions = cliRow.querySelector<HTMLElement>(".onboarding-cli-actions")!;
        actions.textContent = "Starting…";
        try {
          const { running, command } = await runClaudeInstall(method);
          const body = cliRow.querySelector<HTMLElement>(".onboarding-cli-body")!;
          if (running) {
            actions.textContent = "";
            body.textContent =
              "Terminal is running the installer — restart LingCodeBaby when it finishes.";
          } else {
            actions.textContent = "";
            body.innerHTML =
              "Couldn't open a terminal. The command is on your clipboard — run it yourself:<br>" +
              `<code></code>`;
            body.querySelector("code")!.textContent = command;
          }
        } catch (e) {
          errEl.textContent = String(e);
          actions.textContent = "";
        }
      };
    });

    const finish = async () => {
      await markComplete();
      overlay.remove();
      resolve();
    };

    skip.onclick = () => {
      if (hardGate) return;
      finish();
    };

    overlay.querySelectorAll<HTMLButtonElement>(".onboarding-card").forEach((btn) => {
      btn.onclick = async () => {
        errEl.textContent = "";
        const choice = btn.dataset.choice!;
        try {
          switch (choice) {
            case "lingmodel": {
              const existing = await api.deployGetSavedToken();
              if (!existing) {
                const tok = await tokenPrompt(
                  () => api.deploySignin(),
                  "Sign in to LingCode to use LingModel.",
                );
                if (!tok) return; // user cancelled — keep the gate open
              }
              await finish();
              break;
            }
            case "subscription": {
              // Nothing to configure — the CLI handles `claude login` itself.
              // Just close the gate so the user can start chatting.
              await alertDialog(
                "Make sure you've run `claude login` in your terminal at least once. " +
                "The Claude Code CLI stores credentials in its own config; the app inherits them.",
              );
              await finish();
              break;
            }
            case "endpoint": {
              await showEndpointSheet();
              const cfg = await api.endpointGetConfig();
              if (cfg.enabled && cfg.key_present) await finish();
              // else: sheet was cancelled or fields incomplete — keep gate open
              break;
            }
            case "anthropic": {
              const key = await promptText(
                "Paste your Anthropic API key (sk-ant-…). Stored in the OS Keychain, never on disk:",
                "",
              );
              if (!key) return;
              await api.anthropicKeySave(key);
              await finish();
              break;
            }
          }
        } catch (e) {
          errEl.textContent = String(e);
        }
      };
    });
  });
}

/** Show the gate on launch if nothing is configured AND the user hasn't
 *  explicitly cleared it before. `hardGate=true` — user must pick a path. */
export async function showOnboardingIfNeeded(): Promise<void> {
  const prefs = await api.getPrefs();
  if (prefs.onboarding_complete) return;
  if (await isAuthenticated()) {
    // Something is set up already — skip the gate but remember, so we don't
    // re-nag on later launches even if the user signs out.
    await markComplete();
    return;
  }
  await showOnboarding(true);
}
