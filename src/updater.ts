import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirmDialog, alertDialog } from "./ui";

// Check for an update. `silent` suppresses the "you're up to date" / error
// dialogs (used for the automatic check on launch); the menu item passes false.
export async function checkForUpdates(silent: boolean) {
  try {
    const update = await check();
    if (!update) {
      if (!silent) await alertDialog("You're on the latest version of LingCodeBaby.");
      return;
    }
    const ok = await confirmDialog(
      `LingCodeBaby ${update.version} is available (you have ${update.currentVersion}).\n\n${update.body ?? ""}\n\nDownload and install now?`,
      "Update Now"
    );
    if (!ok) return;
    await update.downloadAndInstall();
    if (await confirmDialog("Update installed. Restart LingCodeBaby now?", "Restart")) {
      await relaunch();
    }
  } catch (e) {
    if (!silent) await alertDialog("Couldn't check for updates: " + String(e));
  }
}
