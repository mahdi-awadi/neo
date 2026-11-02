// Bidi helpers shared by the server renderer (format.ts) and the console bundle (web/text-lines.ts):
// one rule for "numbers stay left-to-right in Arabic text". Pure, no dependencies, so the browser
// bundle can import it.

/** Arabic or Hebrew script anywhere in the text. */
export const RTL_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** A number in prose: not inside a word (E2E stays), with its separators ("10:30", "1,250", "2026-10-20", "40%"). */
const NUMBER = String.raw`(?<![\p{L}\d_])\d(?:[\d,.:/%-]*\d)?%?(?![\p{L}\d_])`;
const NUMBER_HTML = new RegExp(String.raw`&#?\w+;|${NUMBER}`, "gu");
const NUMBER_TEXT = new RegExp(NUMBER, "gu");

/** Numbers in prose of an RTL line become an isolated LTR run, so "10:30" or "1,250" never flips in Arabic.
 *  Applied to already-escaped text: entities are skipped, a digit inside a word (E2E) is left alone. */
export function numbersLtr(escaped: string): string {
  return escaped.replace(NUMBER_HTML, (m) => (m.startsWith("&") ? m : `<bdi dir="ltr" class="n">${m}</bdi>`));
}

/** The same rule for plain text (a Telegram line without markup): each number between the Unicode
 *  LEFT-TO-RIGHT ISOLATE and POP DIRECTIONAL ISOLATE marks. */
export function numbersLtrText(text: string): string {
  return text.replace(NUMBER_TEXT, (m) => `\u2066${m}\u2069`);
}
