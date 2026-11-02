// Arabic light stemming for the task history (ADR-0067, spec "Text processing"): the Light10 rules with the
// prefix and suffix lists and the length limits of Lucene's ArabicStemmer. The stems go into
// `chunks_fts.stems`, so `مقاعد` finds `والمقاعدُ`. Pure. English words get FTS5's `porter` instead.
import { normalize } from "./normalize";

/** Tried in this order; the first that fits is removed (one prefix at most). */
const PREFIXES = ["ال", "وال", "بال", "كال", "فال", "لل", "و"];
/** Tried in this order; each that fits is removed in turn. */
const SUFFIXES = ["ها", "ان", "ات", "ون", "ين", "يه", "ية", "ه", "ة", "ي"];

/** An Arabic-script letter run (marks, digits and punctuation are not letters). */
const ARABIC_WORD = /(?:(?=\p{Script=Arabic})\p{L})+/gu;

/** Lucene's limits: a one-letter prefix needs a word of 4 or more; any prefix leaves at least 2 letters. */
function prefixFits(word: string, prefix: string): boolean {
  if (prefix.length === 1 && word.length < 4) return false;
  return word.length >= prefix.length + 2 && word.startsWith(prefix);
}

/** A suffix leaves at least 2 letters. */
function suffixFits(word: string, suffix: string): boolean {
  return word.length >= suffix.length + 2 && word.endsWith(suffix);
}

/** The light stem of one Arabic word (expected normalized; letters only). */
export function arabicStem(word: string): string {
  let w = word;
  const prefix = PREFIXES.find((p) => prefixFits(w, p));
  if (prefix) w = w.slice(prefix.length);
  for (const s of SUFFIXES) if (suffixFits(w, s)) w = w.slice(0, -s.length);
  return w;
}

/** The stems of the Arabic-script words of `text` (normalized first), joined by spaces. Latin words and
 *  digits give nothing. */
export function arabicStems(text: string): string {
  return Array.from(normalize(text).matchAll(ARABIC_WORD), (m) => arabicStem(m[0])).join(" ");
}
