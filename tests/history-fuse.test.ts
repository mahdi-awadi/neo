// ADR-0066 the fusion of the search lists (spec "Search", step 6): weighted reciprocal rank fusion by ref,
// the best chunk of a ref gives its rank, exact hits first, the newer hit first on a tie, equal text
// collapsed into one hit with `alsoIn`, and the limit.
import { describe, expect, test } from "bun:test";
import { fuse, type FuseOpts } from "../src/engine/history/fuse";

const OPTS: FuseOpts = { k: 60, weights: { meaning: 1, words: 1, lines: 0.5 }, exactBoost: 1, limit: 10 };
const hit = (ref: string, at = 1, textHash?: string, chunkId?: number) => ({ ref, at, ...(textHash ? { textHash } : {}), ...(chunkId ? { chunkId } : {}) });

describe("fuse", () => {
  test("the RRF sums with the list weights; a ref's best chunk gives its rank", () => {
    const out = fuse({
      words: [hit("a", 1, "ha", 1), hit("a", 1, "ha2", 2), hit("b", 1, "hb", 3)],
      meaning: [hit("b", 1, "hb", 3), hit("a", 1, "ha", 1)],
      lines: [hit("line:9", 1)],
    }, OPTS);
    const score = Object.fromEntries(out.map((h) => [h.ref, h.score]));
    expect(score.a).toBeCloseTo(1 / 61 + 1 / 62, 10); // "a" is rank 1 in words (its second chunk does not count again)
    expect(score.b).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(score["line:9"]).toBeCloseTo(0.5 / 61, 10);
    expect(out.find((h) => h.ref === "a")?.via).toEqual(["meaning", "words"]);
    expect(out.find((h) => h.ref === "a")?.chunkId).toBe(1);
  });

  test("an exact hit comes first", () => {
    const out = fuse({
      exact: [hit("todo:884", 1)],
      words: [hit("x", 9, "hx", 1)],
      meaning: [hit("x", 9, "hx", 1)],
      lines: [hit("line:1", 9)],
    }, OPTS);
    expect(out[0]!.ref).toBe("todo:884");
    expect(out[0]!.via).toEqual(["exact"]);
    expect(out[0]!.score).toBeGreaterThan(1);
  });

  test("on a tie the newer hit comes first", () => {
    const out = fuse({ words: [hit("old", 1, "h1", 1)], meaning: [hit("new", 5, "h2", 2)] }, OPTS);
    expect(out.map((h) => h.ref)).toEqual(["new", "old"]);
  });

  test("equal text collapses into the best hit, which lists the others in alsoIn", () => {
    const out = fuse({ words: [hit("todo:1", 3, "same", 1), hit("order:o1", 2, "same", 2), hit("c", 1, "other", 3)] }, OPTS);
    expect(out.map((h) => h.ref)).toEqual(["todo:1", "c"]);
    expect(out[0]!.alsoIn).toEqual(["order:o1"]);
    expect(out[1]!.alsoIn).toBeUndefined();
  });

  test("the limit applies after the collapse", () => {
    const words = Array.from({ length: 20 }, (_, i) => hit(`r${i}`, i, `h${i}`, i + 1));
    expect(fuse({ words }, { ...OPTS, limit: 5 }).map((h) => h.ref)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(fuse({}, OPTS)).toEqual([]);
  });
});
