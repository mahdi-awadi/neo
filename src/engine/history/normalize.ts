// Task history text normalization (ADR-0066, spec "Text processing"). One rule for `chunks_fts.body`,
// the stems and the query, never for the displayed text. Pure. The map back to the original offsets lets
// a match on the normalized text be highlighted on the original, harakat and all.

/** One original "cluster": a code point and the combining marks after it (or a run of marks alone).
 *  NFKC is applied per cluster, so a mark composes with its base but the map stays exact. */
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gsu;

/** Characters removed after NFKC: tatweel, harakat and Quranic marks, superscript alef, and the zero-width
 *  and bidi format characters. */
const REMOVE = /[ـً-ٰٟۖ-ۭ​-‏‪-‮⁦-⁩﻿]/;

/** Letter folds: the alef forms, alef maqsura, teh marbuta, Persian yeh and keheh. */
const FOLD: Record<string, string> = {
  "أ": "ا", // أ → ا
  "إ": "ا", // إ → ا
  "آ": "ا", // آ → ا
  "ٱ": "ا", // ٱ → ا
  "ى": "ي", // ى → ي
  "ة": "ه", // ة → ه
  "ی": "ي", // ی → ي
  "ک": "ك", // ک → ك
};

/** Arabic-Indic (U+0660) and Persian (U+06F0) digits → ASCII. */
function foldDigit(ch: string): string {
  const c = ch.charCodeAt(0);
  if (c >= 0x0660 && c <= 0x0669) return String.fromCharCode(48 + c - 0x0660);
  if (c >= 0x06f0 && c <= 0x06f9) return String.fromCharCode(48 + c - 0x06f0);
  return ch;
}

export interface Normalized {
  text: string;
  /** `map[i]` is the original offset (UTF-16) of normalized char `i`; `map[text.length]` is the original
   *  length, so a normalized range `[a, b)` is the original range `[map[a], map[b])`. */
  map: number[];
}

/** The normalized text and its offset map. */
export function normalizeWithMap(original: string): Normalized {
  let text = "";
  const map: number[] = [];
  for (const m of original.matchAll(CLUSTER)) {
    const at = m.index;
    for (const ch of m[0].normalize("NFKC")) {
      if (REMOVE.test(ch)) continue;
      const folded = foldDigit(FOLD[ch] ?? ch).toLowerCase();
      for (let i = 0; i < folded.length; i++) map.push(at);
      text += folded;
    }
  }
  map.push(original.length);
  return { text, map };
}

/** The normalized text alone. */
export function normalize(original: string): string {
  return normalizeWithMap(original).text;
}

/** The original range of the normalized range `[start, end)`. The end runs to the next kept character, so
 *  the marks after the last matched letter are inside the range. */
export function toOriginalRange(map: readonly number[], start: number, end: number): [number, number] {
  const last = map.length - 1;
  const s = Math.max(0, Math.min(start, last));
  let e = Math.max(s, Math.min(end, last));
  // A range inside one expanded original character (a ligature) still covers that character.
  while (e > s && e < last && map[e] === map[s]) e++;
  return [map[s]!, map[e]!];
}
