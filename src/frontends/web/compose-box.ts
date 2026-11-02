/// <reference lib="dom" />
// The console's ONE compose box (ADR-0033): every field that takes a message or a brief is a
// <textarea data-compose> handled here, by delegation, so no screen has its own key handling.
//   data-compose="send": Enter sends on a desktop, Shift+Enter (or Alt+Enter) is a new line. On a touch
//     screen Enter is a new line and the Send button sends; Ctrl/Cmd+Enter sends everywhere.
//   data-compose="text": Enter is always a new line (a customer reply draft, a loop prompt).
// Either kind grows with its text up to its CSS max-height, then scrolls. Pasted text keeps its line
// breaks (a textarea's own paste). Sending clicks what a click would: the form's submit, or the
// button marked data-compose-submit next to the box.

export interface EnterKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  /** 229: Safari's Enter that ends an IME composition reports isComposing false, but this code. */
  keyCode?: number;
}

/** What an Enter does in a compose box. "ignore": not ours (another key, or an IME composing a word). */
export function enterKey(e: EnterKeyEvent, box: { touch: boolean; sends: boolean }): "send" | "newline" | "ignore" {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return "ignore";
  if (!box.sends || e.shiftKey || e.altKey) return "newline";
  if (e.ctrlKey || e.metaKey) return "send";
  return box.touch ? "newline" : "send";
}

/** The box's height for its content: the content height up to the max (NaN = no max), then a scrollbar. */
export function fitHeight(contentPx: number, maxPx: number): { height: number; scroll: boolean } {
  if (Number.isFinite(maxPx) && contentPx > maxPx) return { height: maxPx, scroll: true };
  return { height: contentPx, scroll: false };
}

type Box = HTMLTextAreaElement;
const isBox = (el: EventTarget | null): el is Box => el instanceof HTMLTextAreaElement && el.dataset.compose !== undefined;

/** Size the box to its text. The max height lives in the CSS (max-height), not here. */
export function fitBox(el: Box): void {
  if (el.value === "") {
    // Empty: back to the CSS size. Measuring would size the box to its placeholder, which wraps on a phone.
    el.style.height = "";
    el.style.overflowY = "";
    return;
  }
  el.style.height = "auto";
  const borders = el.offsetHeight - el.clientHeight;
  const fit = fitHeight(el.scrollHeight + borders, parseFloat(getComputedStyle(el).maxHeight));
  el.style.height = `${fit.height}px`;
  el.style.overflowY = fit.scroll ? "auto" : "hidden";
}

/** Empty the box after a send, and shrink it back to one line. */
export function clearBox(el: Box): void {
  el.value = "";
  fitBox(el);
}

function submit(el: Box): void {
  if (el.form) {
    const send = el.form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (!send?.disabled) el.form.requestSubmit(); // a disabled Send (uploads pending) stays disabled
    return;
  }
  el.parentElement?.querySelector<HTMLElement>("[data-compose-submit]")?.click();
}

/** Bind every compose box in `root`, now and later (boxes rendered after this call included). */
export function bindComposeBoxes(root: Document): void {
  const touch = matchMedia("(pointer: coarse)");
  root.addEventListener("keydown", (ev) => {
    if (!isBox(ev.target)) return;
    const what = enterKey(ev, { touch: touch.matches, sends: ev.target.dataset.compose === "send" });
    if (what !== "send") return; // a new line is the textarea's own Enter
    ev.preventDefault();
    submit(ev.target);
  });
  root.addEventListener("input", (ev) => {
    if (isBox(ev.target)) fitBox(ev.target);
  });
}
