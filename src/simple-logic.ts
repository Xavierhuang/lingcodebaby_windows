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
    while (j < rows.length && (rows[j].kind === "tool" || rows[j].kind === "edit" || rows[j].kind === "thinking" || rows[j].kind === "note")) j++;
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
  const used = new Set<string>(["lingmodel"]);
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
