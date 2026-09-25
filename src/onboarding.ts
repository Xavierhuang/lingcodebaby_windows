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

import { api } from "./api";
import { showEndpointSheet } from "./endpoint";
import { tokenPrompt, alertDialog, promptText } from "./ui";

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
              Claude Code is included with LingCodeBaby. Sign in once with
              your Claude account (Pro / Team / etc.); nothing to install.
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
              // The CLI owns the login (credentials live in ~/.claude and the
              // app inherits them). The bundled copy is not on PATH, so open
              // the sign-in for the user instead of telling them to type it.
              try {
                await alertDialog(await api.claudeLogin());
              } catch (e) {
                await alertDialog(
                  "Couldn't open the sign-in. If you have Claude Code installed, run `claude login` " +
                  "in a terminal once; the app inherits it. " + String(e),
                );
              }
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
