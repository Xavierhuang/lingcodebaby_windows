// Lightweight DOM modals + context menu, so file operations don't depend on
// extra native dialog permissions for text entry.

// Token sign-in prompt. Primary path: the browser device-flow (`signIn`) opens
// LingCode, the user signs in, and the token is captured automatically — no
// paste. A manual paste field is offered as a fallback if that doesn't complete.
export function tokenPrompt(signIn: () => Promise<string>, message: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">Sign in to LingCode Cloud</div>
        <div class="modal-sub"></div>
        <button class="modal-signin">↗ Sign in with LingCode</button>
        <div class="modal-status" hidden></div>
        <details class="modal-manual">
          <summary>Paste a token manually instead</summary>
          <input class="modal-input" type="password" placeholder="Paste your access token (lcat_…)" />
        </details>
        <div class="modal-buttons">
          <button class="modal-cancel">Cancel</button>
          <button class="modal-ok">Save &amp; Continue</button>
        </div>
      </div>`;
    (overlay.querySelector(".modal-sub") as HTMLElement).textContent = message;
    const input = overlay.querySelector(".modal-input") as HTMLInputElement;
    const signinBtn = overlay.querySelector(".modal-signin") as HTMLButtonElement;
    const status = overlay.querySelector(".modal-status") as HTMLElement;
    document.body.appendChild(overlay);

    const close = (val: string | null) => { overlay.remove(); resolve(val); };

    signinBtn.onclick = async () => {
      signinBtn.disabled = true;
      status.hidden = false;
      status.textContent = "Waiting for sign-in in your browser…";
      try {
        const token = await signIn();
        if (token) { close(token); return; }
        throw new Error("No token received.");
      } catch (e) {
        status.textContent = "Sign-in didn't complete (" + String(e) + "). You can retry or paste a token below.";
        signinBtn.disabled = false;
        (overlay.querySelector(".modal-manual") as HTMLDetailsElement).open = true;
      }
    };
    (overlay.querySelector(".modal-ok") as HTMLElement).onclick = () => close(input.value.trim() || null);
    (overlay.querySelector(".modal-cancel") as HTMLElement).onclick = () => close(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") close(input.value.trim() || null);
      if (e.key === "Escape") close(null);
    };
  });
}

export function promptText(title: string, def = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title"></div>
        <input class="modal-input" type="text" />
        <div class="modal-buttons">
          <button class="modal-cancel">Cancel</button>
          <button class="modal-ok">OK</button>
        </div>
      </div>`;
    (overlay.querySelector(".modal-title") as HTMLElement).textContent = title;
    const input = overlay.querySelector(".modal-input") as HTMLInputElement;
    input.value = def;
    document.body.appendChild(overlay);
    input.focus();
    input.select();
    const close = (val: string | null) => { overlay.remove(); resolve(val); };
    (overlay.querySelector(".modal-ok") as HTMLElement).onclick = () => close(input.value.trim() || null);
    (overlay.querySelector(".modal-cancel") as HTMLElement).onclick = () => close(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") close(input.value.trim() || null);
      if (e.key === "Escape") close(null);
    };
  });
}

export function confirmDialog(message: string, okLabel = "OK"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title"></div>
        <div class="modal-buttons">
          <button class="modal-cancel">Cancel</button>
          <button class="modal-ok"></button>
        </div>
      </div>`;
    (overlay.querySelector(".modal-title") as HTMLElement).textContent = message;
    (overlay.querySelector(".modal-ok") as HTMLElement).textContent = okLabel;
    document.body.appendChild(overlay);
    const close = (val: boolean) => { overlay.remove(); resolve(val); };
    (overlay.querySelector(".modal-ok") as HTMLElement).onclick = () => close(true);
    (overlay.querySelector(".modal-cancel") as HTMLElement).onclick = () => close(false);
  });
}

export function alertDialog(message: string): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title"></div>
        <div class="modal-buttons">
          <button class="modal-ok">OK</button>
        </div>
      </div>`;
    (overlay.querySelector(".modal-title") as HTMLElement).textContent = message;
    document.body.appendChild(overlay);
    (overlay.querySelector(".modal-ok") as HTMLElement).onclick = () => { overlay.remove(); resolve(); };
  });
}

// A multi-choice dialog; resolves with the index of the clicked button (-1 if dismissed).
export function choiceDialog(message: string, buttons: string[]): Promise<number> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const btnHtml = buttons
      .map((_, i) => `<button class="modal-choice ${i === buttons.length - 1 ? "modal-ok" : ""}" data-i="${i}"></button>`)
      .join("");
    overlay.innerHTML = `<div class="modal"><div class="modal-title"></div><div class="modal-buttons">${btnHtml}</div></div>`;
    (overlay.querySelector(".modal-title") as HTMLElement).textContent = message;
    overlay.querySelectorAll<HTMLButtonElement>(".modal-choice").forEach((el, i) => {
      el.textContent = buttons[i];
      el.onclick = () => { overlay.remove(); resolve(Number(el.dataset.i)); };
    });
    document.body.appendChild(overlay);
  });
}

export interface MenuAction { label: string; action: () => void; }

export function contextMenu(x: number, y: number, items: MenuAction[]) {
  document.querySelector(".ctx-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "ctx-item";
    el.textContent = it.label;
    el.onclick = () => { menu.remove(); it.action(); };
    menu.appendChild(el);
  }
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  document.body.appendChild(menu);
  const dismiss = () => { menu.remove(); document.removeEventListener("mousedown", dismiss); };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}
