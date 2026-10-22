// ADR-0045: the waiting-sweep CLI over a real ledger file and a real git repo, and the checked-in loop.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import { validateLoopInput, type LoopInput } from "../src/engine/loop-validate";
import { runSweep } from "../tools/threads/sweep";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sweep-repo-"));
  const g = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.md"), "x");
  g("add", ".");
  g("commit", "-qm", "first");
  return dir;
}

function world() {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "sweep-led-")), "ledger.db");
  const led = openLedger(ledgerPath);
  const t = createTrace({ ledger: led, registry: createRegistry() });
  const root = t.inbound({ chatId: 7, text: "pick a bank", surface: "telegram" });
  const folder = repo();
  const id = led.openDecision({ kind: "decision", question: "Which bank?", cause: root, folder, project: "p" }, 1_000);
  t.refreshThread(root.threadId);
  return { ledgerPath, led, t, root, folder, id };
}

test("check: decisions to judge → exit 1; list shows them; keep → check prints the reminder once", () => {
  const w = world();
  expect(runSweep(["check", "--ledger", w.ledgerPath])).toEqual({ code: 1, stdout: "" });
  const list = runSweep(["list", "--ledger", w.ledgerPath]);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain(`#${w.id.slice(0, 8)}`);
  expect(list.stdout).toContain("Which bank?");
  expect(list.stdout).toContain("first"); // the repo's commits since the question
  expect(runSweep(["keep", w.id.slice(0, 8), "--ask", "Pick the top-up bank", "--ledger", w.ledgerPath]).code).toBe(0);
  const once = runSweep(["check", "--ledger", w.ledgerPath]);
  expect(once).toEqual({ code: 0, stdout: `⏳ Waiting on you (1):\n• ${w.t.ref(w.root.threadId)} p — Pick the top-up bank\n` });
  expect(runSweep(["check", "--ledger", w.ledgerPath])).toEqual({ code: 0, stdout: "" });
});

test("close with a real commit supersedes the decision; bad input exits 2 with the reason", () => {
  const w = world();
  const sha = spawnSync("git", ["-C", w.folder, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
  expect(runSweep(["close", w.id.slice(0, 8), "--commit", sha, "--ledger", w.ledgerPath])).toEqual({ code: 2, stdout: "reason must be 10–300 characters\n" });
  const ok = runSweep(["close", w.id.slice(0, 8), "--commit", sha, "--reason", "the bank was chosen in ADR-1", "--ledger", w.ledgerPath]);
  expect(ok.code).toBe(0);
  const led = openLedger(w.ledgerPath);
  expect(led.decisionById(w.id)).toMatchObject({ status: "superseded", answer: `done by later work: the bank was chosen in ADR-1 (commit ${sha})` });
  expect(runSweep(["nope", "--ledger", w.ledgerPath]).code).toBe(2);
});

test("the checked-in waiting-sweep loop is valid: hourly, goal = sweep check, reports its goal", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "../docs/loops/waiting-sweep.json"), "utf8")) as LoopInput & { promptFile: string };
  const prompt = readFileSync(join(import.meta.dir, "../docs/loops", raw.promptFile), "utf8");
  const r = validateLoopInput({ ...raw, prompt }, { existingNames: [], folderOk: () => true });
  expect("def" in r).toBe(true);
  if (!("def" in r)) return;
  expect(r.def.trigger).toEqual({ kind: "cron", expr: "0 * * * *" });
  expect(r.def.goal).toMatchObject({ kind: "command", command: ["sh", "-c", "bun tools/threads/sweep.ts check"] });
  expect(r.def.report).toBe("goal");
  expect(r.def.freshSession).toBe(true);
  expect(prompt).toContain("sweep.ts list");
  expect(prompt).toContain("sweep.ts close");
  expect(prompt).toContain("sweep.ts keep");
});
