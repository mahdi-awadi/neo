// The tools-enrich loop (ADR-0044 Phase 4, spec A6): weekly, a worker reads what searches missed and
// improves the cards' tags and examples. `misses.ts` is its read-only input; the loop is off by default.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { validateLoopInput, type LoopInput } from "../src/engine/loop-validate";
import { runMisses } from "../tools/catalogue/misses";

const DAY = 86_400_000;

function ledgerWith(events: Array<{ terms: unknown; project?: string; at: number }>): string {
  const path = join(mkdtempSync(join(tmpdir(), "misses-")), "ledger.db");
  const led = openLedger(path);
  for (const e of events) led.recordEvent("tools_miss", { folder: "/p", at: e.at, data: { project: e.project ?? "waselni", terms: e.terms } });
  led.recordEvent("tool_api", { at: Date.now(), data: { card: "x", terms: ["noise"] } });
  return path;
}

test("list: the terms of the last N days, most frequent first, with their projects; older ones do not count", () => {
  const now = Date.now();
  const path = ledgerWith([
    { terms: ["lottie", "animation"], at: now - DAY },
    { terms: ["lottie"], project: "gold", at: now - 2 * DAY },
    { terms: ["ancient"], at: now - 9 * DAY },
    { terms: "not a list", at: now - DAY },
  ]);
  const r = runMisses(["list", "--days", "7", "--ledger", path], { now: () => now });
  expect(r.code).toBe(0);
  const lines = r.stdout.trim().split("\n");
  expect(lines[0]).toMatch(/^2 searches found no tool since .*\. Terms, most frequent first:$/);
  expect(lines[1]).toBe("lottie · 2 · gold, waselni");
  expect(lines[2]).toBe("animation · 1 · waselni");
  expect(r.stdout).not.toContain("ancient");
  expect(r.stdout).not.toContain("noise");
});

test("check is the goal: unmet while misses are unhandled, met after a mark on a real branch", () => {
  const now = Date.now();
  const path = ledgerWith([{ terms: ["lottie"], at: now - DAY }]);
  const branches = new Set(["chore/tools-enrich-x"]);
  const git = (_: string, a: string[]) => (branches.has(a.at(-1)!.replace("refs/heads/", "")) ? "sha\n" : undefined);
  expect(runMisses(["check", "--ledger", path], { now: () => now }).code).toBe(1);
  expect(runMisses(["mark", "--branch", "nope", "--ledger", path], { git, now: () => now }).code).toBe(2);
  expect(runMisses(["mark", "--branch", "-x", "--ledger", path], { git, now: () => now }).code).toBe(2);
  expect(runMisses(["mark", "--ledger", path], { git, now: () => now }).code).toBe(2);
  expect(runMisses(["check", "--ledger", path], { now: () => now }).code).toBe(1); // a refused mark changes nothing
  expect(runMisses(["mark", "--branch", "chore/tools-enrich-x", "--ledger", path], { git, now: () => now })).toEqual({ code: 0, stdout: "marked 1 searches as handled (branch chore/tools-enrich-x)\n" });
  expect(runMisses(["check", "--ledger", path], { now: () => now })).toEqual({ code: 0, stdout: "" });
  // A new miss after the mark → unmet again; `--none` with a reason handles it.
  openLedger(path).recordEvent("tools_miss", { at: now + 1000, data: { project: "gold", terms: ["qr"] } });
  expect(runMisses(["check", "--ledger", path], { now: () => now + 2000 }).code).toBe(1);
  expect(runMisses(["list", "--ledger", path], { now: () => now + 2000 }).stdout).toContain("qr · 1 · gold");
  expect(runMisses(["mark", "--none", "  ", "--ledger", path], { git, now: () => now + 2000 }).code).toBe(2);
  expect(runMisses(["mark", "--none", "qr is a one-off name", "--ledger", path], { git, now: () => now + 2000 }).code).toBe(0);
  expect(runMisses(["check", "--ledger", path], { now: () => now + 3000 }).code).toBe(0);
});

test("no misses → check met, list says so; a bad command or --days → exit 2", () => {
  const path = ledgerWith([]);
  expect(runMisses(["check", "--ledger", path]).code).toBe(0);
  expect(runMisses(["list", "--ledger", path]).stdout).toStartWith("no search missed since ");
  expect(runMisses(["list", "--days", "0", "--ledger", path]).code).toBe(2);
  expect(runMisses(["frob", "--ledger", path]).code).toBe(2);
});

test("the checked-in tools-enrich loop is valid: weekly, off by default, goal = the catalogue test", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "../docs/loops/tools-enrich.json"), "utf8")) as LoopInput & { promptFile: string };
  const prompt = readFileSync(join(import.meta.dir, "../docs/loops", raw.promptFile), "utf8");
  const r = validateLoopInput({ ...raw, prompt }, { existingNames: [], folderOk: () => true });
  expect("def" in r).toBe(true);
  if (!("def" in r)) return;
  expect(r.def.trigger).toMatchObject({ kind: "cron" });
  expect((r.def.trigger as { expr: string }).expr.split(" ")[4]).toMatch(/^[0-6]$/); // one weekday: weekly
  // runLoop checks the goal BEFORE each iteration: the goal must be unmet while there is work, so it is
  // "no unhandled miss", not the catalogue test (green almost always, so no worker would ever run).
  expect(r.def.goal).toMatchObject({ kind: "command", command: ["sh", "-c", "bun tools/catalogue/misses.ts check"] });
  expect(raw.enabledByDefault).toBe(false);
  expect(r.def.freshSession).toBe(true);
  expect(prompt).toContain("misses.ts list");
  expect(prompt).toContain("misses.ts mark");
  expect(prompt).toContain("bun test tests/tools-catalogue.test.ts");
  expect(prompt).toContain("tools_miss");
  expect(prompt).toMatch(/never (set|promote)[^.\n]*active/i);
});
