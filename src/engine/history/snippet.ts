// The task history's snippets (ADR-0067, spec "Search" step 7): about `chars` characters of a chunk's
// original text around the first match of a search term, the matched word marked with SNIPPET_OPEN and
// SNIPPET_CLOSE (format.ts). Terms are matched on the normalized text and the match is mapped back through
// the normalizer's offset map, so the mark covers the original word with its harakat. A cut never splits a
// letter from its marks or a surrogate pair. Pure.
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../format";
import { normalizeWithMap, toOriginalRange } from "./normalize";

const WORD_CHAR = /[\p{L}\p{N}]/u;
/** A character that belongs to the one before it: a combining mark or the low half of a surrogate pair. */
const CONTINUES = /^(?:\p{M}|[\uDC00-\uDFFF])$/u;
const ELLIPSIS = "…";

const tidy = (s: string): string => s.replace(/\s+/g, " ");

/** Move `i` back (or forward) off a mark or a low surrogate, so the cut falls between two characters. */
function settle(text: string, i: number, dir: -1 | 1): number {
  let j = i;
  while (j > 0 && j < text.length && CONTINUES.test(text[j]!)) j += dir;
  return j;
}

/** The first match of any term (the longest at the same place), widened to its whole word, as an original
 *  range; undefined when no term occurs. `terms` are normalized. */
function firstMatch(text: string, terms: string[]): [number, number] | undefined {
  const { text: norm, map } = normalizeWithMap(text);
  let best: [number, number] | undefined;
  for (const term of terms) {
    if (!term) continue;
    const at = norm.indexOf(term);
    if (at < 0) continue;
    if (!best || at < best[0] || (at === best[0] && at + term.length > best[1])) best = [at, at + term.length];
  }
  if (!best) return undefined;
  let [s, e] = best;
  while (s > 0 && WORD_CHAR.test(norm[s - 1]!)) s--;
  while (e < norm.length && WORD_CHAR.test(norm[e]!)) e++;
  return toOriginalRange(map, s, e);
}

export function makeSnippet(text: string, terms: string[], chars: number): string {
  const match = firstMatch(text, terms);
  if (!match) {
    if (text.length <= chars) return tidy(text).trim();
    return `${tidy(text.slice(0, settle(text, chars, 1))).trim()}${ELLIPSIS}`;
  }
  const [os, oe] = match;
  const room = Math.max(0, chars - (oe - os));
  let a = Math.max(0, os - Math.floor(room / 2));
  let b = Math.min(text.length, oe + (room - (os - a)));
  a = settle(text, a, -1);
  b = settle(text, b, 1);
  return [
    a > 0 ? ELLIPSIS : "",
    tidy(text.slice(a, os)).trimStart(),
    SNIPPET_OPEN, tidy(text.slice(os, oe)), SNIPPET_CLOSE,
    tidy(text.slice(oe, b)).trimEnd(),
    b < text.length ? ELLIPSIS : "",
  ].join("");
}
