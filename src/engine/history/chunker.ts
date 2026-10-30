// Task history chunker (ADR-0066, spec "Text processing"). Cuts a source text into chunks of about
// `chars` characters that repeat `overlap` characters of the one before. The cut prefers a paragraph end,
// then a line end, then a sentence end (`. ! ? ؟ ۔`), then a space, then a grapheme boundary
// (`Intl.Segmenter`), so an emoji or a letter with its marks is never split. Pure.
import type { ChunkCfg } from "./defaults";

export interface Chunk {
  seq: number;
  /** `source.slice(start, end)`, trimmed. */
  text: string;
  start: number;
  end: number;
}

const SENTENCE_END = new Set([".", "!", "?", "؟", "۔"]);
const SPACE = /\s/;

/** Chunks of `text`. A source shorter than `minChars` gives none; one with more than `maxPerRef` chunks is
 *  cut there and `cut` is true. */
export function chunkText(text: string, cfg: ChunkCfg): { chunks: Chunk[]; cut: boolean } {
  const chunks: Chunk[] = [];
  if (text.trim().length < cfg.minChars) return { chunks, cut: false };
  const size = Math.max(1, cfg.chars);
  const overlap = Math.max(0, Math.min(cfg.overlap, size - 1));
  const end = text.trimEnd().length;
  const graphemes = lazyBoundaries(text);
  let pos = skipSpace(text, 0, end);
  while (pos < end) {
    const last = end - pos <= size;
    const cut = last ? end : findCut(text, pos, pos + size, graphemes);
    const piece = trimmed(text, pos, cut);
    if (piece) chunks.push({ seq: chunks.length, ...piece });
    if (last) break;
    if (chunks.length >= cfg.maxPerRef) return { chunks, cut: true };
    const next = overlapStart(text, Math.max(pos + 1, cut - overlap), cut, graphemes);
    pos = skipSpace(text, next > pos ? next : cut, end);
  }
  return { chunks, cut: false };
}

/** Where a chunk that starts at `pos` ends, at most at `limit`. The preferred cuts are looked for only in the
 *  second half of the window, so a chunk is never much shorter than `chars`. */
function findCut(text: string, pos: number, limit: number, graphemes: () => number[]): number {
  const min = pos + Math.ceil((limit - pos) / 2);
  const para = text.lastIndexOf("\n\n", limit);
  if (para >= min) return para;
  const line = text.lastIndexOf("\n", limit);
  if (line >= min) return line;
  for (let i = limit - 1; i >= min - 1; i--) {
    if (SENTENCE_END.has(text[i]!) && (i + 1 >= text.length || SPACE.test(text[i + 1]!))) return i + 1;
  }
  for (let i = limit; i >= min; i--) if (SPACE.test(text[i] ?? "")) return i;
  const b = graphemes();
  const at = lastAtMost(b, limit);
  if (at > pos) return at;
  // One grapheme longer than the whole window: keep it whole.
  return b[firstAtLeast(b, pos + 1)] ?? text.length;
}

/** Where the next chunk starts: the first word after `from`. With no word start in the overlap, the cut
 *  itself when it was at a space (never start inside a word), else the first grapheme boundary after `from`. */
function overlapStart(text: string, from: number, cut: number, graphemes: () => number[]): number {
  for (let i = from; i < cut; i++) if (SPACE.test(text[i]!)) return i + 1;
  if (SPACE.test(text[cut] ?? " ")) return cut;
  const b = graphemes();
  return Math.min(b[firstAtLeast(b, from)] ?? cut, cut);
}

function trimmed(text: string, start: number, end: number): Omit<Chunk, "seq"> | undefined {
  let s = start;
  let e = end;
  while (s < e && SPACE.test(text[s]!)) s++;
  while (e > s && SPACE.test(text[e - 1]!)) e--;
  return e > s ? { text: text.slice(s, e), start: s, end: e } : undefined;
}

function skipSpace(text: string, i: number, end: number): number {
  while (i < end && SPACE.test(text[i]!)) i++;
  return i;
}

/** The grapheme boundaries of `text` (sorted, with 0 and the length), made once and only when needed. */
function lazyBoundaries(text: string): () => number[] {
  let cache: number[] | undefined;
  return () => {
    if (!cache) {
      cache = [];
      for (const s of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) cache.push(s.index);
      cache.push(text.length);
    }
    return cache;
  };
}

/** The index of the first boundary `>= x` (the length of `b` when none). */
function firstAtLeast(b: number[], x: number): number {
  let lo = 0;
  let hi = b.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The largest boundary `<= x` (-1 when none). */
function lastAtMost(b: number[], x: number): number {
  const i = firstAtLeast(b, x + 1) - 1;
  return i >= 0 ? b[i]! : -1;
}
