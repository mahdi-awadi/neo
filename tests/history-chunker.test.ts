// ADR-0067: the task history chunker. About `chars` characters with `overlap`; the cut prefers a paragraph
// end, then a line end, then a sentence end, then a word, then a grapheme boundary. Pure.
import { expect, test } from "bun:test";
import { chunkText } from "../src/engine/history/chunker";
import { CHUNK_DEFAULTS } from "../src/engine/history/defaults";

const cfg = (over: Partial<typeof CHUNK_DEFAULTS> = {}) => ({ ...CHUNK_DEFAULTS, ...over });

test("a short source is one chunk; a source below minChars is not indexed", () => {
  expect(chunkText("Fix the seat release after a cancelled booking.", cfg())).toEqual({
    chunks: [{ seq: 0, text: "Fix the seat release after a cancelled booking.", start: 0, end: 47 }],
    cut: false,
  });
  expect(chunkText("  too short  ", cfg())).toEqual({ chunks: [], cut: false });
  expect(chunkText("", cfg())).toEqual({ chunks: [], cut: false });
});

test("chunks respect the size, overlap the one before, and cover the whole text", () => {
  const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const { chunks, cut } = chunkText(text, cfg({ chars: 200, overlap: 40 }));
  expect(cut).toBe(false);
  expect(chunks.length).toBeGreaterThan(10);
  expect(chunks[0]!.start).toBe(0);
  expect(chunks.at(-1)!.end).toBe(text.length);
  chunks.forEach((c, i) => {
    expect(c.seq).toBe(i);
    expect(c.text).toBe(text.slice(c.start, c.end));
    expect(c.text.length).toBeLessThanOrEqual(200);
    if (i > 0) {
      const prev = chunks[i - 1]!;
      expect(c.start).toBeLessThan(prev.end); // overlaps
      expect(prev.end - c.start).toBeLessThanOrEqual(40);
      expect(c.start).toBeGreaterThan(prev.start); // always moves on
    }
    // A word is never cut.
    expect(c.text).toMatch(/^word\d+( word\d+)*$/);
  });
});

test("the cut prefers a paragraph end over a line end over a sentence end", () => {
  const para = `${"a".repeat(80)} end one.\n\n${"b".repeat(30)} line\n${"c".repeat(20)}. after ${"d".repeat(200)}`;
  const first = chunkText(para, cfg({ chars: 150, overlap: 0 })).chunks[0]!;
  expect(first.text).toBe(`${"a".repeat(80)} end one.`);

  const line = `${"a".repeat(80)} end one.\n${"b".repeat(30)} two. ${"c".repeat(200)}`;
  expect(chunkText(line, cfg({ chars: 150, overlap: 0 })).chunks[0]!.text).toBe(`${"a".repeat(80)} end one.`);

  const sentence = `${"a".repeat(60)} one? ${"b".repeat(20)} two؟ ${"c".repeat(200)}`;
  expect(chunkText(sentence, cfg({ chars: 150, overlap: 0 })).chunks[0]!.text).toBe(`${"a".repeat(60)} one? ${"b".repeat(20)} two؟`);

  const urdu = `${"a".repeat(80)} ختم۔ ${"c".repeat(200)}`;
  expect(chunkText(urdu, cfg({ chars: 150, overlap: 0 })).chunks[0]!.text).toBe(`${"a".repeat(80)} ختم۔`);
});

test("an emoji is never split, even with no space anywhere", () => {
  const family = "👨‍👩‍👧‍👦";
  const text = family.repeat(200);
  const { chunks } = chunkText(text, cfg({ chars: 100, overlap: 20 }));
  expect(chunks.length).toBeGreaterThan(5);
  for (const c of chunks) expect(c.text).toMatch(/^(👨‍👩‍👧‍👦)+$/u);
  expect(chunks.at(-1)!.end).toBe(text.length);
});

test("an Arabic word with marks is never split", () => {
  const word = "والمَقاعِدُ";
  const text = Array.from({ length: 120 }, () => word).join(" ");
  const { chunks } = chunkText(text, cfg({ chars: 100, overlap: 25 }));
  expect(chunks.length).toBeGreaterThan(5);
  for (const c of chunks) expect(c.text.split(" ").every((w) => w === word)).toBe(true);

  // No spaces: the cut still lands on a grapheme boundary, never between a letter and its mark.
  const run = "مَ".repeat(300);
  for (const c of chunkText(run, cfg({ chars: 101, overlap: 11 })).chunks) expect(c.text).toMatch(/^(مَ)+$/u);
});

test("maxPerRef cuts the source and flags it", () => {
  const text = "x ".repeat(5000);
  const r = chunkText(text, cfg({ chars: 100, overlap: 10, maxPerRef: 3 }));
  expect(r.chunks.length).toBe(3);
  expect(r.cut).toBe(true);
});

test("a 100 KB result is chunked within the defaults", () => {
  const sentence = "The booking service released the seats after the cancel webhook arrived. ";
  const text = sentence.repeat(Math.ceil(100_000 / sentence.length));
  const t0 = performance.now();
  const { chunks, cut } = chunkText(text, cfg());
  expect(performance.now() - t0).toBeLessThan(2_000);
  expect(cut).toBe(false);
  expect(chunks.length).toBeGreaterThan(80);
  expect(chunks.length).toBeLessThanOrEqual(CHUNK_DEFAULTS.maxPerRef);
  for (const c of chunks) {
    expect(c.text.length).toBeLessThanOrEqual(CHUNK_DEFAULTS.chars);
    expect(c.text.endsWith(".")).toBe(true); // a sentence end
  }
  expect(chunks.at(-1)!.end).toBe(text.trimEnd().length);
});
