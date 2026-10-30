// ADR-0071: the on-screen keyboard on a phone. Android resizes the layout to the visual viewport
// (interactive-widget=resizes-content); iOS does not, so a bottom sheet would sit behind the keyboard. The
// console lifts the sheet by the part of the layout viewport the keyboard covers.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyboardInset } from "../src/frontends/web/viewport";

const WEB = join(import.meta.dir, "../src/frontends/web");
const APP = readFileSync(join(WEB, "app.ts"), "utf8");
const SHELL = readFileSync(join(WEB, "index.html"), "utf8");

test("keyboardInset: what the keyboard covers below the visual viewport; never negative", () => {
  expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toBe(0); // no keyboard
  expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336); // iOS: the layout stays, the visual shrinks
  expect(keyboardInset(844, { height: 508, offsetTop: 40 })).toBe(296); // the page scrolled up under it
  expect(keyboardInset(508, { height: 508, offsetTop: 0 })).toBe(0); // Android: the layout already shrank
  expect(keyboardInset(844, { height: 900, offsetTop: 0 })).toBe(0); // a zoom-out never gives a negative inset
  expect(keyboardInset(844, { height: 507.6, offsetTop: 0 })).toBe(336);
});

test("the console keeps --kb current and the phone sheet sits above it, its height within the visual viewport", () => {
  const fit = APP.slice(APP.indexOf("function fitViewport("), APP.indexOf("\nfunction ", APP.indexOf("function fitViewport(") + 1));
  expect(fit).toContain('root.style.setProperty("--kb", `${keyboardInset(window.innerHeight, vv)}px`)');
  expect(SHELL).toMatch(/@media \(max-width:640px\)\{\.sheet\{[^}]*margin:auto 0 var\(--kb,0px\)[^}]*max-height:min\(88vh,var\(--app-h,100dvh\)\)/);
});
