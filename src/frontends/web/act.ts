// One way for a console button to act (ADR-0065): while its request runs the button is busy (disabled,
// aria-busy, the `busy` style); after it, a toast carries the engine's own reply — "queued as #N", the
// refusal reason, or fallback words when the reply has none. A tap on a busy button sends nothing.

/** The part of a button the helper touches (a real HTMLButtonElement fits; tests pass a fake). */
export interface ActButton {
  disabled: boolean;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
}

export interface ActResult {
  ok: boolean;
  text: string;
  /** The reply body, for a caller that needs more than the text (the SDK switch). */
  data?: unknown;
}

/** An engine reply as a toast: its `text` (or `error`), ok unless it says `ok: false` or the HTTP status
 *  failed. Pure. */
export function actOutcome(status: number, body: unknown): ActResult {
  const b = (body && typeof body === "object" ? body : {}) as { ok?: unknown; text?: unknown; error?: unknown };
  const text = typeof b.text === "string" && b.text ? b.text : typeof b.error === "string" ? b.error : "";
  const ok = status >= 200 && status < 300 && b.ok !== false && !(typeof b.error === "string" && b.error && !b.text);
  return { ok, text };
}

/** Run one button's request with its busy state and a toast. `fallback` gives the words for a reply with
 *  no text (from the locale catalogue). Never throws. */
export async function runAct(
  btn: ActButton | null,
  request: () => Promise<Response>,
  o: { toast: (text: string, ok: boolean) => void; fallback: (ok: boolean) => string },
): Promise<ActResult> {
  if (btn?.classList.contains("busy")) return { ok: false, text: "" };
  if (btn) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.classList.add("busy");
  }
  let r: ActResult;
  try {
    const res = await request();
    const data: unknown = await res.json().catch(() => null);
    r = { ...actOutcome(res.status, data), ...(data !== null ? { data } : {}) };
  } catch {
    r = { ok: false, text: "" };
  }
  if (!r.text) r = { ...r, text: o.fallback(r.ok) };
  if (btn) {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.classList.remove("busy");
  }
  o.toast(r.text, r.ok);
  return r;
}
