import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTitle, groupByDay, foldTurns, adoptLegacy, paneLayout, outcomeOptions, kindBadge,
} from "../simple-logic.ts";

test("a chat's title is its first user message, cut at a word boundary under 60 chars", () => {
  assert.equal(deriveTitle("Make the header sticky"), "Make the header sticky");
  const long = "Please rewrite the landing page so the hero section explains the product in one sentence and add a signup form";
  const t = deriveTitle(long);
  assert.ok(t.length <= 60, t);
  assert.ok(!t.endsWith(" "), "no trailing space");
  assert.ok(long.startsWith(t.replace(/…$/, "")), "prefix of the message");
  assert.equal(deriveTitle("   "), "New chat");
  assert.equal(deriveTitle("line one\nline two"), "line one", "first line only");
});

test("chats group into Today / Yesterday / Earlier by updatedAt, newest first", () => {
  const now = Date.parse("2026-09-27T15:00:00Z");
  const day = 86_400_000;
  const chats = [
    { id: "a", title: "old", updatedAt: now - 5 * day },
    { id: "b", title: "today-early", updatedAt: now - 3 * 3_600_000 },
    { id: "c", title: "yesterday", updatedAt: now - day },
    { id: "d", title: "today-late", updatedAt: now - 60_000 },
  ];
  const groups = groupByDay(chats, now);
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Yesterday", "Earlier"]);
  assert.deepEqual(groups[0].chats.map((c) => c.id), ["d", "b"]);
  assert.deepEqual(groups[1].chats.map((c) => c.id), ["c"]);
  assert.deepEqual(groups[2].chats.map((c) => c.id), ["a"]);
  assert.deepEqual(groupByDay([], now), [], "no empty groups");
});

test("a turn's tool and edit rows fold into one summary line between the user and the answer", () => {
  const rows = [
    { kind: "user", text: "fix it" },
    { kind: "thinking", text: "hmm" },
    { kind: "tool", text: "🔧 Bash ls" },
    { kind: "edit", text: "✏️ Edit src/a.ts\n+ x" },
    { kind: "edit", text: "✏️ Write src/b.ts\n+ y" },
    { kind: "tool", text: "🔧 Read src/a.ts" },
    { kind: "assistant", text: "done" },
    { kind: "user", text: "thanks" },
    { kind: "assistant", text: "np" },
  ];
  const folds = foldTurns(rows);
  assert.equal(folds.length, 1, "only the first turn has steps");
  assert.deepEqual([folds[0].start, folds[0].end], [1, 5], "rows 1..5 inclusive are the steps");
  assert.equal(folds[0].summary, "Edited 2 files · Ran 2 commands");
  assert.equal(foldTurns([{ kind: "user", text: "a" }, { kind: "assistant", text: "b" }]).length, 0);
  // A single edit and no commands reads naturally.
  const one = foldTurns([{ kind: "user", text: "a" }, { kind: "edit", text: "✏️ Edit x\n+ 1" }, { kind: "assistant", text: "b" }]);
  assert.equal(one[0].summary, "Edited 1 file");
  // Steps still in flight (no assistant row yet) are not folded.
  assert.equal(foldTurns([{ kind: "user", text: "a" }, { kind: "tool", text: "🔧 Bash" }]).length, 0);
});

test("a legacy single conversation is adopted as the first chat and its session id is kept unless it was itself adopted", () => {
  const legacy = { session: "sess-1", model: "opus", messages: [{ kind: "user", text: "hi", clean: true }, { kind: "assistant", text: "hello", clean: true }] };
  const chat = adoptLegacy(legacy, 1_700_000_000_000);
  assert.equal(chat.title, "hi");
  assert.equal(chat.session, "sess-1");
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.createdAt, 1_700_000_000_000);
  assert.ok(chat.id.length >= 8);
  const twice = adoptLegacy({ ...legacy, adopted_legacy: true }, 1);
  assert.equal(twice.session, null, "a session the other app owns must not be resumed here");
  assert.equal(adoptLegacy({ session: null, model: null, messages: [] }, 1), null, "nothing to adopt");
});

test("panes auto-collapse when the window is too narrow, right panel first", () => {
  // conversations 240 + divider 1 + chat 440 + divider 8 + panel ≥ 280 = 969
  assert.deepEqual(paneLayout(1280, { panelWidth: 400, conversationsHidden: false, panelHidden: false }),
    { conversations: 240, panel: 400 });
  assert.deepEqual(paneLayout(900, { panelWidth: 400, conversationsHidden: false, panelHidden: false }),
    { conversations: 240, panel: 36 }, "panel collapses to its strip first");
  assert.deepEqual(paneLayout(700, { panelWidth: 400, conversationsHidden: false, panelHidden: false }),
    { conversations: 0, panel: 36 }, "then the conversations list");
  assert.deepEqual(paneLayout(1280, { panelWidth: 400, conversationsHidden: true, panelHidden: true }),
    { conversations: 0, panel: 36 }, "user choices are respected when there is room");
  assert.deepEqual(paneLayout(1000, { panelWidth: 380, conversationsHidden: false, panelHidden: false }),
    { conversations: 240, panel: 311 }, "the panel shrinks to its minimum share before collapsing");
});

test("the outcome picker offers the three Mac tiers plus LingModel, then everything else", () => {
  const names = { lingmodel: "LingModel", default: "Default", opus55: "Opus 5.5", sonnet: "Sonnet", haiku: "Haiku", fable51: "Fable 5.1", "deepseek-v4-pro": "DeepSeek V4 Pro" };
  const groups = outcomeOptions(names);
  assert.deepEqual(groups[0].options.map((o) => [o.value, o.label]), [
    ["lingmodel", "LingModel"], ["opus55", "Best quality · Opus 5.5"], ["sonnet", "Fast · Sonnet"], ["haiku", "Cheap · Haiku"],
  ]);
  assert.equal(groups[1].label, "More models");
  assert.deepEqual(groups[1].options.map((o) => o.value), ["default", "fable51", "deepseek-v4-pro"]);
});

test("the kind badge says Web app only when the folder has an index.html", () => {
  assert.equal(kindBadge(true), "Web app");
  assert.equal(kindBadge(false), "Project");
});
