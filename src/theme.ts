// Appearance control. The app followed the OS and offered no way to override it;
// this adds System / Light / Dark, persisted in prefs.json.
//
// Three states, not two. "System" deliberately stamps NOTHING on <html>, so the
// stylesheet's `prefers-color-scheme` block decides. An explicit choice stamps
// data-theme, which the stylesheet gives higher precedence than the media query
// in both directions — so picking Light on a dark OS works, and vice versa.

export type Appearance = "system" | "light" | "dark";

const OS_DARK = "(prefers-color-scheme: dark)";
const listeners: Array<(dark: boolean) => void> = [];
let current: Appearance = "system";

/** Is the UI dark right now, after resolving "system" against the OS? */
export function isDark(): boolean {
  if (current === "dark") return true;
  if (current === "light") return false;
  return window.matchMedia(OS_DARK).matches;
}

export function appearance(): Appearance {
  return current;
}

/** Apply a mode and notify anything that can't be styled by CSS alone. */
export function applyAppearance(mode: Appearance) {
  current = mode;
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  notify();
}

/** Subscribe to dark/light changes; fires immediately with the current state.
 *  CodeMirror picks its own colours in JS, so it can't follow the CSS. */
export function onAppearanceChange(fn: (dark: boolean) => void) {
  listeners.push(fn);
  fn(isDark());
}

function notify() {
  const dark = isDark();
  for (const fn of listeners) fn(dark);
}

// While on "system", track the OS flipping (e.g. Windows sunset scheduling).
window.matchMedia(OS_DARK).addEventListener("change", () => {
  if (current === "system") notify();
});
