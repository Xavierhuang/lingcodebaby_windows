import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { searchKeymap, openSearchPanel, findNext, findPrevious } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { php } from "@codemirror/lang-php";
import { StreamLanguage } from "@codemirror/language";
import { c } from "@codemirror/legacy-modes/mode/clike";
import { shell } from "@codemirror/legacy-modes/mode/shell";

// Xcode-Light-like palette, matching the original SyntaxHighlighter colours.
const xcodeLight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "#aa0d91" },
  { tag: [t.typeName, t.className, t.namespace], color: "#3f6e75" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#007400" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#c41a16" },
  { tag: [t.number, t.bool, t.atom], color: "#1c00cf" },
  { tag: [t.meta, t.processingInstruction], color: "#643820" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#6c36a9" },
  { tag: [t.propertyName, t.attributeName], color: "#3f6e75" },
  { tag: t.tagName, color: "#aa0d91" },
]);

// Xcode-Dark counterpart. The light palette was the only one that existed, so in
// dark mode the editor drew #1c00cf navy and #007400 bottle green on a near-black
// ground — and CodeMirror, never told it was dark, kept its own light defaults
// including a BLACK caret. Same tag set, same order, dark-mode values.
const xcodeDark = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "#fc5fa3" },
  { tag: [t.typeName, t.className, t.namespace], color: "#9ef1dd" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#7f8c98" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#fc6a5d" },
  { tag: [t.number, t.bool, t.atom], color: "#d0bf69" },
  { tag: [t.meta, t.processingInstruction], color: "#fd8f3f" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#67b7a4" },
  { tag: [t.propertyName, t.attributeName], color: "#b281eb" },
  { tag: t.tagName, color: "#fc5fa3" },
]);

// Quinny (.qn) — a task-oriented intent language: eleven reserved words,
// indentation blocks, `#` line comments, no string literals. Port of the Mac
// app's syntax/lang_quinny.c so .qn files highlight on both platforms.
const QUINNY_KEYWORDS = new Set([
  "project", "task", "component", "goal", "input", "output",
  "constraint", "depends", "uses", "test", "success",
]);

const quinny = StreamLanguage.define<{}>({
  name: "quinny",
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") { stream.skipToEnd(); return "comment"; }
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_-]*/)) {
      return QUINNY_KEYWORDS.has(stream.current().toLowerCase()) ? "keyword" : null;
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
});

const language = new Compartment();
const appearance = new Compartment();

// Chrome the CSS can't reach: CodeMirror renders the gutters and caret itself.
// Colours come from the same custom properties as the rest of the app, so these
// follow the token blocks in styles.css instead of duplicating them. The `dark`
// flag is what switches CodeMirror's own base theme (caret, selection,
// active-line) between its &light and &dark rules.
function appearanceExtensions(dark: boolean) {
  return [
    syntaxHighlighting(dark ? xcodeDark : xcodeLight),
    EditorView.theme(
      {
        "&": { backgroundColor: "var(--bg)", color: "var(--text)" },
        ".cm-gutters": {
          backgroundColor: "var(--panel)",
          color: "var(--muted)",
          borderRight: "1px solid var(--border)",
        },
        ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
        ".cm-selectionBackground, ::selection": { backgroundColor: "var(--sel)" },
      },
      { dark },
    ),
  ];
}

function langForPath(path: string) {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (name === "makefile" || name.endsWith(".mk")) return StreamLanguage.define(shell);
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": case "ts": case "tsx":
      return javascript({ jsx: ext.includes("x"), typescript: ext.startsWith("t") });
    case "py": case "pyw": return python();
    case "json": return json();
    case "css": return css();
    case "html": case "htm": return html();
    case "php": return php();
    case "c": case "h": case "cpp": case "cc": case "hpp": case "m": case "mm":
      return StreamLanguage.define(c);
    case "sh": case "bash": case "zsh": return StreamLanguage.define(shell);
    case "qn": case "quinny": return quinny;
    default: return [];
  }
}

export class CodeEditor {
  view: EditorView;
  onChange: () => void = () => {};

  constructor(parent: HTMLElement, dark = false) {
    const state = EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        appearance.of(appearanceExtensions(dark)),
        language.of([]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onChange();
        }),
      ],
    });
    this.view = new EditorView({ state, parent });
  }

  /** Swap the syntax palette and CodeMirror's base theme in place — no reload,
   *  no loss of the open document, cursor or undo history. */
  setDark(dark: boolean) {
    this.view.dispatch({ effects: appearance.reconfigure(appearanceExtensions(dark)) });
  }

  setContent(text: string, path: string) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      effects: language.reconfigure(langForPath(path) as any),
    });
    // Reset history baseline so a freshly-loaded file isn't "undoable" to empty.
    this.view.dispatch({ selection: { anchor: 0 } });
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  openFind() { openSearchPanel(this.view); this.view.focus(); }
  findNext() { findNext(this.view); }
  findPrev() { findPrevious(this.view); }
  focus() { this.view.focus(); }
}
