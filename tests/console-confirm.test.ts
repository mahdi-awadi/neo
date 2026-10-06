// A destructive one-tap control (the project kill ✕) needs a second tap on every pointer (it is
// always visible on touch, next to the row's own tap target): the first tap arms it, a second tap within the
// window fires, a late second tap arms again.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";
import { CONFIRM_WINDOW_MS, armedFor, confirmTap } from "../src/frontends/web/confirm";

const APP = readFileSync(join(import.meta.dir, "../src/frontends/web/app.ts"), "utf8");

test("confirmTap: arm, then fire inside the window; a late tap arms again", () => {
  expect(confirmTap(undefined, 1000)).toBe("arm");
  expect(confirmTap(1000, 1000 + CONFIRM_WINDOW_MS - 1)).toBe("fire");
  expect(confirmTap(1000, 1000 + CONFIRM_WINDOW_MS + 1)).toBe("arm");
});

test("the kill button uses an icon (no font glyph), an accessible name, and the two-tap rule", () => {
  expect(APP).not.toContain('k.textContent = "✕"');
  expect(APP).toContain("confirmTap(");
  expect(APP).toMatch(/k\.setAttribute\("aria-label"/);
  expect(en.projects.killConfirm).toBeTruthy();
  expect(ar.projects.killConfirm).toBeTruthy();
  expect(ar.projects.killConfirm).not.toBe(en.projects.killConfirm);
});

test("armedFor: an arm survives a re-render inside the window and expires after it", () => {
  const arms = new Map<number, number>();
  expect(armedFor(arms, 1, 5000)).toBeUndefined();
  arms.set(1, 1000);
  expect(armedFor(arms, 1, 1000 + CONFIRM_WINDOW_MS - 1)).toBe(1000);
  expect(armedFor(arms, 1, 1000 + CONFIRM_WINDOW_MS + 1)).toBeUndefined();
  expect(arms.has(1)).toBe(false); // an expired arm is dropped
});

test("renderProjects keeps kill arms in a module-level Map and restores them on rebuild", () => {
  expect(APP).toMatch(/^const killArms = new Map<[^>]+>\(\);$/m);
  expect(APP).toContain("armedFor(killArms, p.id");
  expect(APP).toContain("killArms.delete(p.id)");
});
