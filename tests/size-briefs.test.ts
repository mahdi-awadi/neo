// ADR-0072 (spec §7, AC 6): a dispatch preamble for each order size. Big is today's preamble, byte for byte;
// quick and standard are shorter, and keep the security, fence and push rules, AR+EN and LTR numbers.
import { expect, test } from "bun:test";
import { briefForSize, briefWithProjectDocs, codebaseMemoryLine } from "../src/engine/dispatch";
import { stripEngineBlocks, unwrapContinuation } from "../src/engine/history/extract";
import { continuationBrief } from "../src/engine/context-policy";
import { FINISH_RULE, PLAN_RULE, PUSH_RULE, QUALITY_RULE, STOP_RULE, TECH_RULE } from "../src/engine/standing-rules";
import { ORDER_SIZES } from "../src/engine/order-size";

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
// Characterization: briefWithProjectDocs("TASK") as it was before the paragraphs moved into constants.
const BIG_SHA = "3f991cd6c5c7302dae53bf92ddc9b8f2343cd933b530e00bca6f3fe453926a31";
const TASK = "Fix the seat release: when a booking is cancelled the bus seats are not freed.\n\nSee todo #884.";
const LONG_MEMORY_LINE = codebaseMemoryLine({ project: "home-" + "x".repeat(80) });

// The paragraphs every size keeps, cut from the big preamble by their headings.
const paragraph = (head: string) => {
  const big = briefWithProjectDocs("");
  const at = big.indexOf(head);
  return big.slice(at, big.indexOf("\n\n", at) + 2);
};
const SECURITY = paragraph("REQUIRED — security:");
const FENCE = paragraph("REQUIRED — stay in this project:");

test("characterization: the big preamble is unchanged", () => {
  expect(sha256(briefWithProjectDocs("TASK"))).toBe(BIG_SHA);
});

test("big is today's preamble, byte for byte", () => {
  expect(briefForSize("big", "T")).toBe(briefWithProjectDocs("T"));
  expect(briefForSize("big", TASK)).toBe(briefWithProjectDocs(TASK));
  expect(sha256(briefForSize("big", "TASK"))).toBe(BIG_SHA);
});

test("quick: a small fix with the security, fence and push rules, and no plan machinery", () => {
  const q = briefForSize("quick", TASK);
  expect(q.startsWith("QUICK order — ")).toBe(true);
  for (const s of [PUSH_RULE, SECURITY, FENCE, "numbers stay LTR", "AR+EN", "just fix", "2–3 lines", "`history_search`"]) {
    expect(q).toContain(s);
  }
  for (const s of [PLAN_RULE, "`planner` subagent (", "writing-plans", "BIG plan"]) expect(q).not.toContain(s);
  expect(q.endsWith(`\n\nThe order:\n${TASK}`)).toBe(true);
});

test("standard: plan briefly, test-first, with the standing rules and no plan file", () => {
  const s = briefForSize("standard", TASK);
  expect(s.startsWith("STANDARD order — ")).toBe(true);
  for (const x of [FINISH_RULE, PUSH_RULE, QUALITY_RULE, TECH_RULE, STOP_RULE, "test-driven-development", SECURITY, FENCE,
    "numbers stay LTR", "AR+EN"]) {
    expect(s).toContain(x);
  }
  for (const x of [PLAN_RULE, "`planner` subagent ("]) expect(s).not.toContain(x);
  expect(s.endsWith(`\n\nThe order:\n${TASK}`)).toBe(true);
});

test("each rule sentence appears once in each size", () => {
  for (const size of ["quick", "standard"] as const) {
    const b = briefForSize(size, "");
    expect(b.split(PUSH_RULE).length).toBe(2);
    expect(b.split(SECURITY).length).toBe(2);
    expect(b.split(FENCE).length).toBe(2);
  }
});

test("the ceilings hold, also with the long codebase-memory line", () => {
  const withLine = (b: string) => `${LONG_MEMORY_LINE}\n\n${b}`;
  const q = briefForSize("quick", ""), s = briefForSize("standard", "");
  expect(q.length).toBeLessThan(3_000);
  expect(withLine(q).length).toBeLessThan(3_700);
  expect(s.length).toBeLessThan(4_500);
  expect(withLine(s).length).toBeLessThan(5_200);
  expect(q.length).toBeLessThan(s.length);
  expect(s.length).toBeLessThan(briefForSize("big", "").length);
});

test("the task history strips each size's preamble to the operator's brief", () => {
  for (const size of ORDER_SIZES) {
    expect(stripEngineBlocks(briefForSize(size, TASK))).toBe(TASK);
    expect(stripEngineBlocks(briefForSize(size, ""))).toBe("");
    expect(stripEngineBlocks(`${LONG_MEMORY_LINE}\n\n${briefForSize(size, TASK)}`)).toBe(TASK);
    // Inside a continuation, as history/sources.ts reads a brief: strip, unwrap, strip.
    const read = (b: string) => stripEngineBlocks(unwrapContinuation(stripEngineBlocks(b)));
    expect(read(briefForSize(size, continuationBrief(TASK)))).toBe(TASK);
    expect(read(continuationBrief(briefForSize(size, TASK)))).toBe(TASK);
  }
});
