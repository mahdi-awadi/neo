// ADR-0067: what the task history takes out of a text — commit shas, the id tokens of a query, the engine
// blocks Neo wraps around a brief (checked against the REAL builders, so a text change in a builder breaks
// this test, not the index), the continuation wrapper, and boilerplate paragraphs.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findIdTokens, findShas, hashText, paragraphHashes, removeBoilerplate, stripEngineBlocks, unwrapContinuation,
} from "../src/engine/history/extract";
import { briefForSize, briefWithProjectDocs, codebaseMemoryLine } from "../src/engine/dispatch";
import { lanePreamble } from "../src/engine/lanes";
import { teamLeadPreamble } from "../src/engine/agent-teams";
import { applyMemoryOp, memorySnapshot } from "../src/engine/memory";
import { continuationBrief, handoffPreamble } from "../src/engine/context-policy";
import { normalize } from "../src/engine/history/normalize";

const TASK = "Fix the seat release: when a booking is cancelled the bus seats are not freed.\n\nSee todo #884.";

test("shas: a short and a full sha are found", () => {
  expect(findShas("built on dev 479236d, merged as 0123456789abcdef0123456789abcdef01234567.")).toEqual([
    "479236d", "0123456789abcdef0123456789abcdef01234567",
  ]);
  expect(findShas("see https://github.com/x/y/commit/9c419a1 and 9C419A1")).toEqual(["9c419a1"]);
  expect(findShas("479236d and 479236d again")).toEqual(["479236d"]);
});

test("shas: UUID parts, colors, long hex runs, all-digit and all-letter tokens are not shas", () => {
  expect(findShas("order 550e8400-e29b-41d4-a716-446655440000")).toEqual([]);
  expect(findShas("color #ffffff and #ab12cd34ef")).toEqual([]);
  expect(findShas(`hash ${"ab12".repeat(11)}`)).toEqual([]); // 44 hex
  expect(findShas("count 1234567 and word deadbeef and facade0")).toEqual(["facade0"]);
  expect(findShas("branch fix-ab12cd3 and ab12cd3_x")).toEqual([]);
});

test("query ids: todos, plans, notes, decisions, refs, UUIDs, message refs and PNR-like codes", () => {
  const kinds = (q: string) => findIdTokens(q).map((t) => [t.kind, t.value]);
  expect(kinds("#884")).toEqual([["todo", "884"]]);
  expect(kinds("todo 884 and Todo #12")).toEqual([["todo", "884"], ["todo", "12"]]);
  expect(kinds("plan 12")).toEqual([["plan", "12"]]);
  expect(kinds("note 470")).toEqual([["note", "470"]]);
  expect(kinds("#ab12cd34")).toEqual([["decision", "ab12cd34"]]);
  expect(kinds("order 550E8400-e29b-41d4-a716-446655440000")).toEqual([["order", "550e8400-e29b-41d4-a716-446655440000"]]);
  expect(kinds("thread m4f2")).toEqual([["thread", "m4f2"]]);
  expect(kinds("PNR AB12CD please")).toEqual([["pnr", "AB12CD"]]);
  expect(kinds("todo:884 dec:ab12cd34 mem:3")).toEqual([["ref", "todo:884"], ["ref", "dec:ab12cd34"], ["ref", "mem:3"]]);
  expect(kinds("dev 479236d")).toEqual([["sha", "479236d"]]);
});

test("query ids: plain words are not ids", () => {
  expect(findIdTokens("bus seats not freeing up")).toEqual([]);
  expect(findIdTokens("meeting about README and HANDOFF")).toEqual([]);
  expect(findIdTokens("المقاعد لا تتحرر")).toEqual([]);
});

test("query ids carry their span, so the caller can tell an id-only query", () => {
  const q = "todo 884 #ab12cd34";
  const toks = findIdTokens(q);
  expect(toks.map((t) => q.slice(t.start, t.end))).toEqual(["todo 884", "#ab12cd34"]);
});

test("engine blocks: the dispatch preamble from the real builder is removed", () => {
  expect(stripEngineBlocks(briefWithProjectDocs(TASK))).toBe(TASK);
  expect(stripEngineBlocks(briefWithProjectDocs(""))).toBe("");
});

test("engine blocks: the quick and standard preambles from the real builder are removed (ADR-0072)", () => {
  for (const size of ["quick", "standard"] as const) {
    expect(stripEngineBlocks(briefForSize(size, TASK))).toBe(TASK);
    expect(stripEngineBlocks(briefForSize(size, ""))).toBe("");
  }
});

test("engine blocks: both codebase-memory lines from the real builder are removed", () => {
  expect(stripEngineBlocks(`${codebaseMemoryLine({ project: "x" })}\n\n${TASK}`)).toBe(TASK);
  expect(stripEngineBlocks(`${codebaseMemoryLine({})}\n\n${TASK}`)).toBe(TASK);
});

test("engine blocks: the lane preamble of each kind and the team-lead preamble are removed", () => {
  for (const kind of ["read-only", "ops", "test", "code"] as const) {
    const wt = kind === "code" ? { path: "/home/neo-wt-x", branch: "side/1", base: "dev" } : undefined;
    expect(stripEngineBlocks(`${lanePreamble(kind, "eticket", wt)}\n\n${TASK}`)).toBe(TASK);
  }
  expect(stripEngineBlocks(teamLeadPreamble(TASK))).toBe(TASK);
  expect(stripEngineBlocks(teamLeadPreamble(""))).toBe("");
});

test("engine blocks: a memory snapshot and a handoff note are removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-hist-extract-"));
  applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "Runs Bun on Linux" }, 5_000);
  applyMemoryOp(dir, "USER.md", { kind: "add", text: "Prefers short answers" }, 5_000);
  const snap = memorySnapshot(dir, { scopes: ["company"], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 });
  expect(snap).toContain("Runs Bun on Linux");
  expect(stripEngineBlocks(snap + TASK)).toBe(TASK);

  const ledger = { pendingHandoff: () => ({ id: 1, reason: "above-sweet-spot", occupancy: 0.5 }), recordContextEvent: () => 2 } as never;
  const pre = handoffPreamble(dir, ledger, { handoffNoteMaxChars: 20_000 }, 1)!;
  expect(stripEngineBlocks(`${pre.text}\n\n${TASK}`)).toBe(TASK);
  writeFileSync(join(dir, "HANDOFF.md"), "the project's own");
  const own = handoffPreamble(dir, ledger, { handoffNoteMaxChars: 20_000 }, 1)!;
  expect(own.text).toContain("its own HANDOFF.md");
  expect(stripEngineBlocks(`${own.text}\n\n${TASK}`)).toBe(TASK);
});

test("engine blocks: a fully composed order task strips to the operator's brief", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-hist-extract-"));
  applyMemoryOp(dir, "MEMORY.md", { kind: "add", text: "Fact" }, 5_000);
  const snap = memorySnapshot(dir, { scopes: ["company"], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 });
  const ledger = { pendingHandoff: () => ({ id: 1, occupancy: 0.5 }), recordContextEvent: () => 2 } as never;
  const pre = handoffPreamble(dir, ledger, { handoffNoteMaxChars: 20_000 }, 1)!;
  let task = briefWithProjectDocs(teamLeadPreamble(`${lanePreamble("test", "neo")}\n\n${TASK}`));
  task = snap + task;
  task = `${pre.text}\n\n${task}`;
  task = `${codebaseMemoryLine({ project: "home-neo" })}\n\n${task}`;
  expect(stripEngineBlocks(task)).toBe(TASK);
});

test("extract.ts does not import dispatch.ts (the recognizers are text rules, the builders are only in tests)", () => {
  const src = readFileSync(join(import.meta.dir, "../src/engine/history/extract.ts"), "utf8");
  expect(src).not.toMatch(/from\s+["'][^"']*\/dispatch["']/);
});

test("the continuation wrapper unwraps to the original brief, however often it was continued", () => {
  expect(unwrapContinuation(continuationBrief(TASK))).toBe(TASK);
  expect(unwrapContinuation(continuationBrief(continuationBrief(TASK)))).toBe(TASK);
  expect(unwrapContinuation(`${continuationBrief(TASK)}\n\nCarried: the operator's answer.`)).toBe(`${TASK}\n\nCarried: the operator's answer.`);
  expect(unwrapContinuation(continuationBrief())).toBe("");
  expect(unwrapContinuation(TASK)).toBe(TASK);
  // Inside a dispatch preamble: strip the blocks first, then unwrap.
  expect(unwrapContinuation(stripEngineBlocks(briefWithProjectDocs(continuationBrief(TASK))))).toBe(TASK);
});

test("paragraph hashes use the normalized text; boilerplate removal drops the given paragraphs", () => {
  const a = "Read the RULES first.\n\nالمقاعدُ لا تتحرر\n\n  \n\nKeep this one.";
  const b = "read the rules first.\n\nالمقاعد لا تتحرر";
  const ha = paragraphHashes(a);
  expect(ha.length).toBe(3);
  expect(paragraphHashes(b)).toEqual(ha.slice(0, 2));
  expect(ha[0]).toBe(hashText(normalize("Read the RULES first.")));
  expect(paragraphHashes("x\n\nx")).toEqual([hashText("x")]); // distinct per text

  const boiler = new Set([ha[0]!]);
  expect(removeBoilerplate(a, boiler)).toBe("المقاعدُ لا تتحرر\n\nKeep this one.");
  expect(removeBoilerplate(a, new Set())).toBe(a); // nothing to drop: the text is unchanged
});

test("hashText is a stable sha-256 hex", () => {
  expect(hashText("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(hashText("abc")).not.toBe(hashText("abd"));
});
