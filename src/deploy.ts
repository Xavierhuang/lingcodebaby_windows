import { api, deployUpload } from "./api";
import { promptText, confirmDialog, alertDialog, choiceDialog, tokenPrompt } from "./ui";
import { openUrl } from "@tauri-apps/plugin-opener";

function basename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "app";
}

function showProgress(): { setText: (s: string) => void; close: () => void } {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal"><div class="modal-title">Deploying…</div>
    <div class="deploy-status">Starting…</div></div>`;
  document.body.appendChild(overlay);
  const status = overlay.querySelector(".deploy-status") as HTMLElement;
  return {
    setText: (s) => { status.textContent = s; },
    close: () => overlay.remove(),
  };
}

export async function runDeploy(folder: string | null) {
  if (!folder) { await alertDialog("Open a folder first, then deploy it."); return; }

  if (!(await api.deployHasIndex(folder))) {
    if (!(await confirmDialog("No index.html found at the project root. Deploy anyway?", "Deploy"))) return;
  }

  const config = await api.deployLoadConfig(folder);
  const title = (config && config.title) || basename(folder);
  let token: string | null = (config && config.token) || (await api.deployGetSavedToken());
  let slug: string | null = config && config.slug ? config.slug : null;
  let workerId: string | null = config && config.workerId ? config.workerId : null;

  // Ensure we have a token — sign in via the browser device-flow (auto-capture).
  if (!token) {
    token = await tokenPrompt(() => api.deploySignin(), "You're not signed in to LingCode Cloud yet.");
    if (!token) return;
  }

  // Verify token + (for first deploy) choose an available subdomain.
  const isRedeploy = !!(slug || workerId);
  while (true) {
    if (!isRedeploy) {
      const input = await promptText("Choose a subdomain ( <name>.lingcode.app ):", slug || basename(folder));
      if (!input) return;
      slug = await api.deploySlugify(input);
      if (slug.length < 3) { await alertDialog("Use at least 3 characters: lowercase letters, digits and dashes."); continue; }
    }
    const res = await api.deployCheck(token!, slug || "", isRedeploy ? slug : null);
    if (res.status === 401) {
      token = await tokenPrompt(() => api.deploySignin(), "That access token was rejected. Sign in again.");
      if (!token) return;
      continue;
    }
    if (res.status !== 200) {
      await alertDialog(res.message || "Couldn't reach LingCode Cloud.");
      return;
    }
    if (!isRedeploy && !res.available && res.reason !== "current") {
      await alertDialog(res.message || "That subdomain is unavailable. Choose another.");
      continue;
    }
    break;
  }

  // Persist token (keychain + config) before uploading.
  try { await api.deploySaveToken(token!); } catch { /* non-fatal */ }

  const prog = showProgress();
  try {
    const result = await deployUpload(
      { folder, token: token!, slug: isRedeploy ? null : slug, title, workerId },
      (e) => { if (e.text) prog.setText(e.text); }
    );
    prog.close();

    const newConfig = {
      token,
      slug,
      title,
      url: result.url,
      workerId: result.workerId || workerId,
    };
    await api.deploySaveConfig(folder, newConfig);

    const choice = await choiceDialog(
      `Deployed to LingCode Cloud:\n${result.url}`,
      ["Close", "Copy URL", "Open Site"]
    );
    if (choice === 1) {
      try { await navigator.clipboard.writeText(result.url); } catch { /* ignore */ }
    } else if (choice === 2) {
      await openUrl(result.url);
    }
  } catch (err) {
    prog.close();
    await alertDialog("Deploy failed: " + String(err));
  }
}
