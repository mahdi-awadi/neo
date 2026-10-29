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

test("check is the goal: unmet while misses are unhandled, met after a mark through what list printed", () => {
  const now = Date.now();
  const path = ledgerWith([{ terms: ["lottie"], at: now - DAY }]);
  // A fake git: one card branch that changes docs/tools only, one that also changes code.
  const changed: Record<string, string> = { "chore/tools-enrich-x": "docs/tools/playwright.md\n", "chore/tools-enrich-bad": "docs/tools/a.md\nsrc/daemon.ts\n", "chore/tools-enrich-empty": "" };
  const git = (_: string, a: string[]) => {
    const b = Object.keys(changed).find((k) => a.some((x) => x.endsWith(`refs/heads/${k}`)));
    if (!b) return undefined;
    return a[0] === "diff" ? changed[b] : "sha\n";
  };
  const run = (args: string[], at = now) => runMisses([...args, "--ledger", path], { git, now: () => at });
  expect(run(["check"]).code).toBe(1);
  const through = /--through (\d+)/.exec(run(["list"]).stdout)![1]!;
  expect(Number(through)).toBe(now - DAY);
  for (const bad of [
    ["mark", "--through", through, "--branch", "master"], // not a card branch
    ["mark", "--through", through, "--branch", "chore/tools-enrich-nope"], // does not exist
    ["mark", "--through", through, "--branch", "chore/tools-enrich-bad"], // changes code
    ["mark", "--through", through, "--branch", "chore/tools-enrich-empty"], // changes nothing
    ["mark", "--branch", "chore/tools-enrich-x"], // no --through
    ["mark", "--through", through], // neither --branch nor --none
    ["mark", "--through", through, "--none", "--branch", "chore/tools-enrich-x"], // a flag is not a value
    ["mark", "--through", through, "--none", "  "], // no reason
  ]) expect(run(bad).code).toBe(2);
  expect(run(["check"]).code).toBe(1); // a refused mark changes nothing
  expect(run(["mark", "--through", through, "--branch", "chore/tools-enrich-x"])).toEqual({ code: 0, stdout: "marked 1 searches as handled (branch chore/tools-enrich-x)\n" });
  expect(run(["check"])).toEqual({ code: 0, stdout: "" });
});

test("a miss that arrives after list stays unhandled after the mark; --none with a reason handles it", () => {
  const now = Date.now();
  const path = ledgerWith([{ terms: ["lottie"], at: now - DAY }]);
  const run = (args: string[], at: number) => runMisses([...args, "--ledger", path], { now: () => at });
  const through = /--through (\d+)/.exec(run(["list"], now).stdout)![1]!;
  openLedger(path).recordEvent("tools_miss", { at: now + 1000, data: { project: "gold", terms: ["qr"] } }); // while the worker works
  expect(run(["mark", "--through", through, "--none", "lottie is a one-off name"], now + 2000).code).toBe(0);
  expect(run(["check"], now + 3000).code).toBe(1);
  const list = run(["list"], now + 3000).stdout;
  expect(list).toContain("qr · 1 · gold");
  expect(list).not.toContain("lottie");
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
