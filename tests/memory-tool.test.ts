import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryTools, type DreamOpts } from "../src/engine/memory-tool";
import type { MemoryCfg } from "../src/config";

const MEMORY_CFG: MemoryCfg = {
  scopes: [],
  snapshotMaxPct: 0.004,
  userMaxPct: 0.0025,
  dreamMaxMutations: 3,
  dreamMaxAdds: 1,
  dreamMaxNetChars: 250,
  dreamLookbackDays: 14,
};

// A generous window so the ratio caps (memoryChars/userChars) are large enough for these tests'
// short entries never to hit "over capacity" by accident.
const WINDOW_TOKENS = 200_000;

function tmpFolder(): string {
  return mkdtempSync(join(tmpdir(), "neo-memtool-"));
}

function buildTools(folder: string, cfg: MemoryCfg = MEMORY_CFG, dream?: DreamOpts) {
  const [memoryTool, searchTool] = memoryTools(folder, cfg, WINDOW_TOKENS, dream ? { dream } : undefined);
  return { memoryTool, searchTool };
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

test("memory tool: happy-path add writes the entry and reports usage", async () => {
  const folder = tmpFolder();
  const { memoryTool } = buildTools(folder);
  const res = await memoryTool.handler({ file: "MEMORY.md", op: "add", text: "Working on payments migration" }, {});
  expect(textOf(res)).toContain("saved");
  expect(textOf(res)).toContain("MEMORY.md"); // usage line names the file
  expect(textOf(res)).toMatch(/\d+%/); // usage percent
  const content = readFileSync(join(folder, "memory", "MEMORY.md"), "utf-8");
  expect(content).toContain("§ Working on payments migration");
});

test("memory tool: USER.md add uses the userChars cap, independent of MEMORY.md", async () => {
  const folder = tmpFolder();
  const { memoryTool } = buildTools(folder);
  const res = await memoryTool.handler({ file: "USER.md", op: "add", text: "Prefers terse replies" }, {});
  expect(textOf(res)).toContain("saved");
  expect(readFileSync(join(folder, "memory", "USER.md"), "utf-8")).toContain("§ Prefers terse replies");
});

test("memory tool: scan rejection surfaces applyMemoryOp's error text verbatim", async () => {
  const folder = tmpFolder();
  const { memoryTool } = buildTools(folder);
  const res = await memoryTool.handler(
    { file: "MEMORY.md", op: "add", text: "api_key: sk-abcdefghijklmnopqrstuvwx" },
    {},
  );
  expect(textOf(res)).toBe("rejected by scan: looks like a credential");
  // nothing was written
  expect(existsSync(join(folder, "memory", "MEMORY.md"))).toBe(false);
});

test("memory tool: a plain (non-scan) applyMemoryOp error also surfaces verbatim", async () => {
  const folder = tmpFolder();
  const { memoryTool } = buildTools(folder);
  const res = await memoryTool.handler({ file: "MEMORY.md", op: "remove", old_text: "nothing here" }, {});
  expect(textOf(res)).toBe("no match");
});

test("memory_search: no matches", async () => {
  const folder = tmpFolder();
  const { searchTool } = buildTools(folder);
  const res = await searchTool.handler({ query: "anything" }, {});
  expect(textOf(res)).toBe("no matches");
});

test("memory_search: cited hits formatted '<content> — <file> (<day>)'", async () => {
  const folder = tmpFolder();
  mkdirSync(join(folder, "memory", "log"), { recursive: true });
  const logPath = join(folder, "memory", "log", "2026-07-01.md");
  writeFileSync(logPath, "- fixed the payments webhook retry bug\n");
  // Index it the same way appendDailyLog would (via the module's own index, reused by memory_search).
  const { openMemoryIndex } = await import("../src/engine/memory-recall");
  openMemoryIndex(folder).indexFile(logPath, "2026-07-01");

  const { searchTool } = buildTools(folder);
  const res = await searchTool.handler({ query: "webhook" }, {});
  expect(textOf(res)).toBe("fixed the payments webhook retry bug — log/2026-07-01.md (2026-07-01)");
});

// --- Dream mode ---

function makeDream(overrides: Partial<DreamOpts> = {}): { opts: DreamOpts; diary: string[] } {
  const diary: string[] = [];
  const opts: DreamOpts = {
    maxMutations: 3,
    maxAdds: 1,
    maxNetChars: 10_000,
    diary: (line) => diary.push(line),
    ...overrides,
  };
  return { opts, diary };
}

test("dream mode: 2nd add and 4th mutation are rejected; diary records every attempt; both files pre-backed-up", async () => {
  const folder = tmpFolder();
  mkdirSync(join(folder, "memory"), { recursive: true });
  // Seed pre-existing entries directly (bypassing applyMemoryOp) so remove/replace ops are
  // available to spend mutation budget without also spending add budget.
  writeFileSync(join(folder, "memory", "MEMORY.md"), "§ existing1\n§ existing2\n§ existing3");
  writeFileSync(join(folder, "memory", "USER.md"), "§ user fact");

  const { opts, diary } = makeDream({ maxMutations: 3, maxAdds: 1 });
  const { memoryTool } = buildTools(folder, MEMORY_CFG, opts);

  // 1) add — succeeds (mutation 1, add 1)
  const r1 = await memoryTool.handler({ file: "MEMORY.md", op: "add", text: "new1", reason: "learned it" }, {});
  expect(textOf(r1)).toContain("saved");

  // 2) a 2nd add — rejected (adds budget spent, even though mutations budget has room)
  const r2 = await memoryTool.handler({ file: "MEMORY.md", op: "add", text: "new2", reason: "learned it too" }, {});
  expect(textOf(r2)).toBe("dream budget exhausted: adds");
  expect(readFileSync(join(folder, "memory", "MEMORY.md"), "utf-8")).not.toContain("new2");

  // 3) remove — succeeds (mutation 2)
  const r3 = await memoryTool.handler({ file: "MEMORY.md", op: "remove", old_text: "existing1" }, {});
  expect(textOf(r3)).toContain("saved");

  // 4) remove — succeeds (mutation 3, hits the mutations cap)
  const r4 = await memoryTool.handler({ file: "MEMORY.md", op: "remove", old_text: "existing2" }, {});
  expect(textOf(r4)).toContain("saved");

  // 5) a 4th mutation attempt — rejected (mutations budget spent)
  const r5 = await memoryTool.handler({ file: "MEMORY.md", op: "remove", old_text: "existing3", reason: "cleanup" }, {});
  expect(textOf(r5)).toBe("dream budget exhausted: mutations");
  expect(readFileSync(join(folder, "memory", "MEMORY.md"), "utf-8")).toContain("existing3"); // untouched

  // Diary recorded all 5 attempts, applied and rejected alike.
  expect(diary.length).toBe(5);
  expect(diary[0]).toBe("add MEMORY.md: applied — learned it");
  expect(diary[1]).toBe("add MEMORY.md: rejected: dream budget exhausted: adds — learned it too");
  expect(diary[4]).toBe("remove MEMORY.md: rejected: dream budget exhausted: mutations — cleanup");

  // Both memory files were backed up exactly once, before the first attempted mutation.
  const backups = readdirSync(join(folder, "memory", ".backups"));
  expect(backups.some((f) => f.startsWith("MEMORY.md."))).toBe(true);
  expect(backups.some((f) => f.startsWith("USER.md."))).toBe(true);
  expect(backups.length).toBe(2);
});

test("dream mode: an over-budget ADD is pre-rejected WITHOUT ever touching the file — byte-identical, no backup churn", async () => {
  const folder = tmpFolder();
  const { opts, diary } = makeDream({ maxMutations: 10, maxAdds: 10, maxNetChars: 5 });
  const { memoryTool } = buildTools(folder, MEMORY_CFG, opts);

  const res = await memoryTool.handler(
    { file: "MEMORY.md", op: "add", text: "this text is way longer than five characters", reason: "too big" },
    {},
  );
  expect(textOf(res)).toBe("dream budget exhausted: net chars");
  // Pre-rejected before ever applying: the file was never created (byte-identical to "before").
  const path = join(folder, "memory", "MEMORY.md");
  expect(existsSync(path)).toBe(false);
  // No backup churn either — ensureDreamBackup only runs AFTER an add's over-budget pre-check
  // passes, and this add never got that far.
  expect(existsSync(join(folder, "memory", ".backups"))).toBe(false);
  expect(diary).toEqual(["add MEMORY.md: rejected: dream budget exhausted: net chars — too big"]);
});

test("dream mode: zero mutations is a valid, recorded outcome (no backup taken if nothing is ever attempted)", async () => {
  const folder = tmpFolder();
  const { opts, diary } = makeDream();
  buildTools(folder, MEMORY_CFG, opts); // build the tools, but never call the handler
  expect(diary).toEqual([]);
  expect(existsSync(join(folder, "memory", ".backups"))).toBe(false);
});

// --- Revert-failure honesty (a `replace`/`remove` op that lands over budget, whose revert write
// itself then fails) — the mutation stands, and every downstream signal (tool text, diary,
// counters, further ops this run) must say so honestly rather than claim "rejected". ---

test("dream mode: when the net-chars revert write itself fails, the over-budget mutation is reported as APPLIED (not rejected), counted, and halts the run", async () => {
  const folder = tmpFolder();
  mkdirSync(join(folder, "memory"), { recursive: true });
  writeFileSync(join(folder, "memory", "MEMORY.md"), "§ replace-me-original");

  const { opts, diary } = makeDream({ maxMutations: 10, maxAdds: 10, maxNetChars: 1 });
  const [memoryTool] = memoryTools(folder, MEMORY_CFG, WINDOW_TOKENS, {
    dream: opts,
    __revertWrite: () => {
      throw new Error("simulated disk failure");
    },
  });

  // replace/remove growth is only knowable after applying — this one applies, is measured as
  // over the (tiny) net-chars budget, and the injected revert write then throws.
  const res = await memoryTool.handler(
    {
      file: "MEMORY.md",
      op: "replace",
      old_text: "replace-me-original",
      text: "replace-me-original-plus-a-lot-more-characters-than-the-budget-allows",
      reason: "consolidate",
    },
    {},
  );
  expect(textOf(res)).toBe("over budget AND revert failed — mutation stands; treat this run's budget as exhausted");

  // The mutation genuinely stands on disk — it was never (and could never be) undone.
  const content = readFileSync(join(folder, "memory", "MEMORY.md"), "utf-8");
  expect(content).toContain("replace-me-original-plus-a-lot-more-characters-than-the-budget-allows");

  // Diary tells the truth: "applied", not "rejected", with the distinct over-budget marker.
  expect(diary).toEqual([
    "replace MEMORY.md: applied (OVER BUDGET — revert failed) — consolidate",
  ]);

  // Fail-safe: every further mutation attempt this run is hard-refused, and still diaried.
  const res2 = await memoryTool.handler({ file: "MEMORY.md", op: "add", text: "anything else" }, {});
  expect(textOf(res2)).toBe("dream budget exhausted: run halted after a revert failure");
  expect(diary[1]).toBe("add MEMORY.md: rejected: dream run halted (prior revert failure) — no reason given");
  // And the halted attempt truly didn't touch the file either.
  expect(readFileSync(join(folder, "memory", "MEMORY.md"), "utf-8")).not.toContain("anything else");
});

// --- Hash staleness after a successful revert (cosmetic per review, still worth pinning): a
// legitimate op on the same file right after a successful revert must not trip memory.ts's own
// drift guard (ensureDriftBackup), which would otherwise spawn an extra, spurious backup file. ---

test("dream mode: a successful net-chars revert re-records the hash so the NEXT normal op spawns no spurious drift backup", async () => {
  const folder = tmpFolder();
  mkdirSync(join(folder, "memory"), { recursive: true });
  writeFileSync(join(folder, "memory", "MEMORY.md"), "§ replace-me");

  const { opts } = makeDream({ maxMutations: 10, maxAdds: 10, maxNetChars: 1 });
  const [memoryTool] = memoryTools(folder, MEMORY_CFG, WINDOW_TOKENS, { dream: opts }); // real revert write (no override)

  const res = await memoryTool.handler(
    { file: "MEMORY.md", op: "replace", old_text: "replace-me", text: "replace-me-with-far-more-characters-than-the-budget" },
    {},
  );
  expect(textOf(res)).toBe("dream budget exhausted: net chars");
  // Reverted back to the original content.
  expect(readFileSync(join(folder, "memory", "MEMORY.md"), "utf-8")).toBe("§ replace-me");

  const backupsAfterRevert = readdirSync(join(folder, "memory", ".backups")).sort();
  expect(backupsAfterRevert.length).toBe(1); // just the dream pre-run backup of MEMORY.md (USER.md never existed)

  // A normal (non-dream) op on the same file, via applyMemoryOp directly (mirrors how any later
  // real session would touch it) — must NOT see the revert as external drift.
  const { applyMemoryOp } = await import("../src/engine/memory");
  const normal = applyMemoryOp(folder, "MEMORY.md", { kind: "add", text: "a normal new entry" }, 10_000);
  expect(normal.ok).toBe(true);

  const backupsAfterNormalOp = readdirSync(join(folder, "memory", ".backups")).sort();
  expect(backupsAfterNormalOp).toEqual(backupsAfterRevert); // no new (spurious drift) backup appeared
});
