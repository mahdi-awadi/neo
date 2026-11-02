// ADR-0065: every console button gives visible feedback — pressed, then busy (disabled, aria-busy) while
// its request runs, then a toast with the engine's own reply ("queued as #N" or the refusal reason).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actOutcome, runAct, type ActButton } from "../src/frontends/web/act";

const APP = readFileSync(join(import.meta.dir, "../src/frontends/web/app.ts"), "utf8");
const SHELL = readFileSync(join(import.meta.dir, "../src/frontends/web/index.html"), "utf8");

test("actOutcome: the engine's reply text, ok or not; an error field; an HTTP failure; an empty reply", () => {
  expect(actOutcome(200, { ok: true, text: "queued as #912 for neo, position 1" })).toEqual({ ok: true, text: "queued as #912 for neo, position 1" });
  expect(actOutcome(200, { ok: false, text: "no brief template for x" })).toEqual({ ok: false, text: "no brief template for x" });
  expect(actOutcome(200, { ok: false, error: "that item is closed or gone" })).toEqual({ ok: false, text: "that item is closed or gone" });
  // An attention action answers { text, drop } with no ok: a text is a success.
  expect(actOutcome(200, { text: "snoozed 24h", drop: true })).toEqual({ ok: true, text: "snoozed 24h" });
  expect(actOutcome(500, { error: "boom" })).toEqual({ ok: false, text: "boom" });
  expect(actOutcome(404, null)).toEqual({ ok: false, text: "" });
  expect(actOutcome(200, { ok: true })).toEqual({ ok: true, text: "" });
});

function fakeButton(): ActButton & { log: string[]; attrs: Record<string, string> } {
  const cls = new Set<string>();
  const attrs: Record<string, string> = {};
  const log: string[] = [];
  return {
    log,
    attrs,
    disabled: false,
    classList: { add: (c: string) => void cls.add(c), remove: (c: string) => void cls.delete(c), contains: (c: string) => cls.has(c) },
    setAttribute: (k: string, v: string) => void (attrs[k] = v),
    removeAttribute: (k: string) => void delete attrs[k],
  };
}

test("runAct: busy while the request runs, then restored; the toast carries the reply; a second tap while busy is ignored", async () => {
  const b = fakeButton();
  let release!: (r: Response) => void;
  const toasts: Array<[string, boolean]> = [];
  const p = runAct(b, () => new Promise<Response>((r) => (release = r)), { toast: (text, ok) => void toasts.push([text, ok]), fallback: (ok) => (ok ? "done" : "failed") });
  expect(b.disabled).toBe(true);
  expect(b.attrs["aria-busy"]).toBe("true");
  expect(b.classList.contains("busy")).toBe(true);
  // A second tap on the busy button sends nothing.
  let second = 0;
  await runAct(b, async () => (second++, Response.json({})), { toast: () => {}, fallback: () => "" });
  expect(second).toBe(0);
  release(Response.json({ ok: true, text: "queued as #912" }));
  const r = await p;
  expect(r).toMatchObject({ ok: true, text: "queued as #912" });
  expect(b.disabled).toBe(false);
  expect(b.attrs["aria-busy"]).toBeUndefined();
  expect(b.classList.contains("busy")).toBe(false);
  expect(toasts).toEqual([["queued as #912", true]]);
});

test("runAct: a network error or an empty reply still toasts (the fallback words), and the button comes back", async () => {
  const b = fakeButton();
  const toasts: Array<[string, boolean]> = [];
  const o = { toast: (text: string, ok: boolean) => void toasts.push([text, ok]), fallback: (ok: boolean) => (ok ? "done" : "failed") };
  expect(await runAct(b, () => Promise.reject(new Error("offline")), o)).toEqual({ ok: false, text: "failed" });
  expect(await runAct(b, async () => Response.json({ ok: true }), o)).toMatchObject({ ok: true, text: "done" });
  expect(toasts).toEqual([["failed", false], ["done", true]]);
  expect(b.disabled).toBe(false);
});

test("the console sends every action through act(): no bare post() handler is left, and the shell has the toast region", () => {
  // Each POST of a button goes through the one helper; reads (loadState, threads) stay plain fetches.
  // Exempt: the composer's own send and attachment discard (it shows its own progress), and a project row's
  // select, a navigation tap whose feedback is the view it opens.
  const exempt = /"\/msg"|out\.body\)|"\/upload\/discard"|"\/select"/;
  const bare = APP.split("\n").filter((l) => /\bpost\(/.test(l) && !/function post\(/.test(l) && !/act\(|runAct\(/.test(l) && !exempt.test(l));
  expect(bare).toEqual([]);
  expect(SHELL).toContain('id="toasts"');
  expect(SHELL).toMatch(/id="toasts"[^>]*aria-live="polite"/);
  // A toast must show above an open modal sheet: the region is a manual popover, re-shown per toast.
  expect(SHELL).toMatch(/id="toasts"[^>]*popover="manual"/);
  expect(APP).toContain("box.showPopover()");
  expect(SHELL).toMatch(/\.busy\b/);
  expect(SHELL).toMatch(/:active/);
});
