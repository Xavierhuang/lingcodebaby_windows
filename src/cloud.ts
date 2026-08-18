// LingCode Cloud menu actions — the discoverable counterpart to the silent
// backend wiring that runs on every send when signed in. Windows mirror of
// EditorWindowController.connectBackendToFolder: / openBackendConsole:.

import { api } from "./api";
import { openUrl } from "@tauri-apps/plugin-opener";
import { alertDialog, choiceDialog } from "./ui";

const CONSOLE_URL = "https://lingcode.dev/backends.html";

/** Open the LingCode Cloud web console (manage tables, auth, storage, functions). */
export async function openBackendConsole(): Promise<void> {
  try {
    await openUrl(CONSOLE_URL);
  } catch (e) {
    await alertDialog("Couldn't open the backend console: " + String(e));
  }
}

/** Write the `lingcode-cloud` MCP entry into this folder's .mcp.json, with the
 *  same visible confirmation the Mac app gives. Requires sign-in + an open
 *  folder; the two guard messages match the Mac alerts. */
export async function connectBackendToFolder(folder: string | null): Promise<void> {
  if (!folder) {
    await alertDialog(
      "No project folder open\n\n" +
      "The backend is per-project. Open a folder (File ▸ Open Folder…), then connect.",
    );
    return;
  }
  try {
    await api.cloudConnectBackend(folder);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("not-signed-in")) {
      await alertDialog(
        "Sign in to LingCode first\n\n" +
        "Use File ▸ Deploy to LingCode Cloud to sign in, then connect a backend.",
      );
    } else if (msg.includes("no-folder")) {
      await alertDialog(
        "No project folder open\n\n" +
        "The backend is per-project. Open a folder (File ▸ Open Folder…), then connect.",
      );
    } else if (msg.includes("provision-failed")) {
      // The MCP entry IS written at this point, so the agent can still
      // provision lazily on first use — say so rather than implying total
      // failure, but don't claim the console will show anything yet.
      await alertDialog(
        "Backend access is wired up, but creating it failed\n\n" + msg + "\n\n" +
        "The agent can still create one on first use — ask it in chat to add a " +
        "database. If this keeps happening, check that you're still signed in.",
      );
    } else {
      await alertDialog("Couldn't connect the backend: " + msg);
    }
    return;
  }
  const choice = await choiceDialog(
    "Backend created for this project\n\n" +
    "A managed Postgres backend is now live and listed in the console under " +
    "this folder's name. Ask the agent in chat to add tables, user accounts, " +
    "or file storage and it will build on it.",
    ["Open Backend Console", "Done"],
  );
  if (choice === 0) await openBackendConsole();
}
