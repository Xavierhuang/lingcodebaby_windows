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

const language = new Compartment();

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
    default: return [];
  }
}

export class CodeEditor {
  view: EditorView;
  onChange: () => void = () => {};

  constructor(parent: HTMLElement) {
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
        syntaxHighlighting(xcodeLight),
        language.of([]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onChange();
        }),
      ],
    });
    this.view = new EditorView({ state, parent });
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
