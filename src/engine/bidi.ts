// Bidi helpers shared by the server renderer (format.ts) and the console bundle (web/text-lines.ts):
// one rule for "numbers stay left-to-right in Arabic text". Pure, no dependencies, so the browser
// bundle can import it.

/** Arabic or Hebrew script anywhere in the text. */
export const RTL_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** Numbers in prose of an RTL line become an isolated LTR run, so "10:30" or "1,250" never flips in Arabic.
 *  Applied to already-escaped text: entities are skipped, a digit inside a word (E2E) is left alone. */
export function numbersLtr(escaped: string): string {
  return escaped.replace(/&#?\w+;|(?<![\p{L}\d_])\d(?:[\d,.:/%-]*\d)?%?(?![\p{L}\d_])/gu, (m) =>
    m.startsWith("&") ? m : `<bdi dir="ltr" class="n">${m}</bdi>`,
  );
}
