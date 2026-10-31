// Pure, DOM-free logic behind the Simple workspace layout. Everything here is
// unit-tested with node's own runner (src/test/simple-logic.test.ts); the DOM
// modules only call in. Widths and rules mirror the Mac app's
// SimpleWorkspaceView / SimplePaneLayout / ConversationsPane.

export const PANE = {
  conversations: 240,
  chatMinimum: 440,
  messagesMaximum: 760,
  preview: 400,
  previewMinimum: 280,
  previewCollapsed: 36,
  divider: 1,
  dragBand: 8,
} as const;

export interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredRow { kind: string; text: string; clean?: boolean; }

/** The on-disk shape of one chat: <folder>/.lingcode/chats/<id>.json. */
export interface ChatDoc extends ChatMeta {
  session: string | null;
  model: string | null;
  messages: StoredRow[];
}

/** First line of the first user message, cut at a word boundary under 60. */
export function deriveTitle(firstUserText: string): string {
  const line = String(firstUserText || "").split("\n").map((l) => l.trim()).find((l) => l.length) || "";
  if (!line) return "New chat";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 59);
  const at = cut.lastIndexOf(" ");
  return (at > 20 ? cut.slice(0, at) : cut).trimEnd() + "…";
}

export interface DayGroup<T extends { updatedAt: number }> { label: "Today" | "Yesterday" | "Earlier"; chats: T[]; }

/** Today / Yesterday / Earlier by local calendar day, newest first, no empty groups. */
export function groupByDay<T extends { updatedAt: number }>(chats: T[], now: number): DayGroup<T>[] {
  const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups: DayGroup<T>[] = [
    { label: "Today", chats: sorted.filter((c) => c.updatedAt >= today) },
    { label: "Yesterday", chats: sorted.filter((c) => c.updatedAt >= yesterday && c.updatedAt < today) },
    { label: "Earlier", chats: sorted.filter((c) => c.updatedAt < yesterday) },
  ];
  return groups.filter((g) => g.chats.length);
}

export interface Fold { start: number; end: number; summary: string; }

/**
 * Between a user row and the assistant answer that follows it, every
 * tool/edit/thinking row is a "step". Each such run folds into one summary
 * line, like the Mac's TranscriptTurnSummary. A turn still in flight (no
 * assistant row yet) is left alone so the live steps stay visible.
 */
export function foldTurns(rows: StoredRow[]): Fold[] {
  const folds: Fold[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "user") { i++; continue; }
    let j = i + 1;
    while (j < rows.length && (rows[j].kind === "tool" || rows[j].kind === "edit" || rows[j].kind === "thinking" || rows[j].kind === "status" || rows[j].kind === "note")) j++;
    const closed = j < rows.length && rows[j].kind === "assistant";
    const steps = rows.slice(i + 1, j).filter((r) => r.kind === "tool" || r.kind === "edit");
    if (closed && steps.length) {
      const edits = steps.filter((r) => r.kind === "edit").length;
      const runs = steps.filter((r) => r.kind === "tool").length;
      const parts: string[] = [];
      if (edits) parts.push(`Edited ${edits} file${edits === 1 ? "" : "s"}`);
      if (runs) parts.push(`Ran ${runs} command${runs === 1 ? "" : "s"}`);
      folds.push({ start: i + 1, end: j - 1, summary: parts.join(" · ") });
    }
    i = Math.max(j, i + 1);
  }
  return folds;
}

/** What the agent is told after a dropped connection; the `--resume`d session
 *  holds everything it already did. */
export const CONTINUE_PROMPT =
  "The connection dropped. Continue exactly where you left off; don't redo finished steps.";

/** Automatic resumes per turn before the user is handed a Continue button. */
export const RETRY_DELAYS_MS = [2000, 5000, 10000];

/** A failed turn worth resuming on its own: the network or the upstream
 *  hiccupped, not a refusal, a bad key or a used-up quota. */
export function isTransientError(text: string): boolean {
  if (/\b(401|403|invalid api key|authentication|unauthori[sz]ed|forbidden|quota|credit balance|billing)\b/i.test(text)) return false;
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|connection (stopped|error|reset|closed)|stream ended early|fetch failed|network error|overloaded|\b(429|500|502|503|504|529)\b/i.test(text);
}

/** The CLI could not reopen the chat's saved session (`--resume <id>`). */
export function isMissingSession(text: string): boolean {
  return /No conversation found|session .*not found|could not (find|load|resume) session/i.test(text);
}

/** What to show for a turn that ended without a single line of output. */
export function silentExitMessage(stderr: string, code: number | null | undefined): string {
  const why = stderr.trim() ? stderr.trim().slice(-1500) : "It printed no error.";
  const how = typeof code === "number" ? `exit code ${code}` : "no exit code";
  return `Stopped without replying (${how}). ${why}`;
}

/** A fresh session's first prompt: the chat so far (questions and answers,
 *  not the steps), newest kept when it is long, then the request. */
export function recapPrompt(rows: StoredRow[], request: string, budget = 4000): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind !== "user" && r.kind !== "assistant") continue;
    const text = r.text.length > 600 ? r.text.slice(0, 600) + "…" : r.text;
    const line = `${r.kind === "user" ? "User" : "Assistant"}: ${text}`;
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length;
  }
  if (!lines.length) return request;
  return "This chat's earlier session couldn't be reopened, so you are starting fresh. " +
    "The conversation so far (the files on disk already reflect it):\n\n" + lines.join("\n\n") +
    "\n\n---\n\n" + request;
}

/** Legacy `<folder>/.lingcode/chat-baby.json` → the first chat of the new store, or null if empty. */
export function adoptLegacy(
  doc: { session: string | null; model: string | null; messages: StoredRow[]; adopted_legacy?: boolean } | null,
  now: number,
): ChatDoc | null {
  if (!doc || !Array.isArray(doc.messages) || !doc.messages.length) return null;
  const firstUser = doc.messages.find((m) => m.kind === "user");
  return {
    id: newChatId(now),
    title: deriveTitle(firstUser ? firstUser.text : ""),
    createdAt: now,
    updatedAt: now,
    // A row set the OTHER app adopted carries no session of ours to resume.
    session: doc.adopted_legacy ? null : (doc.session ?? null),
    model: doc.model ?? null,
    messages: doc.messages.map((m) => ({ kind: m.kind, text: m.text, clean: m.clean !== false })),
  };
}

export function newChatId(now = Date.now()): string {
  return now.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export interface PaneChoice { panelWidth: number; conversationsHidden: boolean; panelHidden: boolean; }

/**
 * Resolve the side pane widths for a window width: the user's choices win
 * when there is room; otherwise the right panel shrinks to its minimum, then
 * collapses to its strip, then the conversations list goes.
 */
export function paneLayout(windowWidth: number, choice: PaneChoice): { conversations: number; panel: number } {
  const conv = choice.conversationsHidden ? 0 : PANE.conversations;
  const convCost = conv ? conv + PANE.divider : 0;
  if (choice.panelHidden) return { conversations: conv, panel: PANE.previewCollapsed };
  const roomForPanel = windowWidth - convCost - PANE.chatMinimum - PANE.dragBand;
  if (roomForPanel >= choice.panelWidth) return { conversations: conv, panel: choice.panelWidth };
  if (roomForPanel >= PANE.previewMinimum) return { conversations: conv, panel: roomForPanel };
  // Strip first, then drop the conversations list if even that does not fit.
  if (windowWidth - convCost - PANE.chatMinimum - PANE.divider >= PANE.previewCollapsed) {
    return { conversations: conv, panel: PANE.previewCollapsed };
  }
  return { conversations: 0, panel: PANE.previewCollapsed };
}

export interface OutcomeOption { value: string; label: string; }
export interface OutcomeGroup { label: string | null; options: OutcomeOption[]; }

/** The Mac OutcomeModelPicker: three outcome tiers with the model named, then "More models". */
export function outcomeOptions(names: Record<string, string>): OutcomeGroup[] {
  const tiers: Array<[string, string]> = [["opus55", "Best quality"], ["sonnet", "Fast"], ["haiku", "Cheap"]];
  const primary: OutcomeOption[] = [];
  if (names.lingmodel) primary.push({ value: "lingmodel", label: names.lingmodel });
  // The user's own endpoint, when saved: they set it up to use it.
  if (names.custom) primary.push({ value: "custom", label: names.custom });
  const used = new Set<string>(["lingmodel", "custom"]);
  for (const [value, tier] of tiers) {
    if (!names[value]) continue;
    used.add(value);
    primary.push({ value, label: `${tier} · ${names[value]}` });
  }
  const rest = Object.keys(names).filter((k) => !used.has(k)).map((value) => ({ value, label: names[value] }));
  const groups: OutcomeGroup[] = [{ label: null, options: primary }];
  if (rest.length) groups.push({ label: "More models", options: rest });
  return groups;
}

export function kindBadge(hasIndexHtml: boolean): "Web app" | "Project" {
  return hasIndexHtml ? "Web app" : "Project";
}

/** The project pill for whatever Run app would start ("Windows app", "TouchDesigner", …). */
export function badgeForTarget(target: { badge: string } | null): string {
  return target?.badge || "Project";
}

/** The Preview tab's words for an app that runs in its own window. */
export function nativeRunText(label: string, running: boolean | null, starting = false): { title: string; sub: string; button: string } {
  if (starting) return { title: `Starting ${label}…`, sub: "It opens in its own window.", button: "▶ Run again" };
  if (running === true) return { title: `${label} is running`, sub: "It runs in its own window, not in this preview.", button: "▶ Run again" };
  if (running === false) return { title: `${label} isn't running`, sub: "Press Run app to start it in its own window.", button: "▶ Run app" };
  return { title: label, sub: "Runs in its own window, not in this preview.", button: "▶ Run app" };
}

/** The project a picked folder belongs to. `.lingcode` is LingCodeBaby's own
 *  data folder inside a project (chats, run.json); opened by mistake, Run app
 *  found no index.html there and the agent worked one level down from the
 *  real project. Open the project around it instead. */
export function projectRootFor(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const match = /^(.*)[\\/]\.lingcode$/i.exec(trimmed);
  return match && match[1] ? match[1] : path;
}

/** Chat rows in the shape lingcode.dev/remote renders (the Mac's
 *  ClaudeSessionSnapshot messages): whole history, stable ids. */
export function remoteMessages(rows: StoredRow[]) {
  return rows.map((e, i) => {
    const id = `m${i}`;
    switch (e.kind) {
      case "user": return { id, role: "user", content: [{ type: "text", text: e.text }] };
      case "thinking": return { id, role: "assistant", content: [{ type: "thinking", text: e.text }] };
      case "tool": {
        const line = e.text.replace(/^🔧\s*/, "");
        const name = line.split(/\s+/)[0] || "Tool";
        // A string input renders as plain text on lingcode.dev/remote ("→ Bash npm run dev").
        return { id, role: "assistant", content: [{ type: "toolUse", id: `t${i}`, name, input: line.slice(name.length).trim(), ready: true }] };
      }
      case "edit": {
        const first = e.text.split("\n")[0].replace(/^✏️\s*/, "");
        const name = first.split(/\s+/)[0] || "Edit";
        return { id, role: "assistant", content: [{ type: "toolUse", id: `t${i}`, name, input: first.slice(name.length).trim(), ready: true }] };
      }
      case "note": return { id, role: "system", content: [{ type: "text", text: e.text }] };
      default: return { id, role: "assistant", content: [{ type: "text", text: e.text }] };
    }
  });
}
