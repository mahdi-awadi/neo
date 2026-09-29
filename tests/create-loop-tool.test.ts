import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, applyLoopFile } from "../tools/create-loop";
import { LEDGER_PATH, openLedger } from "../src/engine/ledger";
import { effectiveLoops } from "../src/engine/loops";
import type { LoopInput } from "../src/engine/loop-validate";

const scratch = () => mkdtempSync(join(tmpdir(), "neo-looptool-"));

const input = (over: Partial<LoopInput> = {}): LoopInput => ({
  name: "tidy-up",
  summary: "tidy the folder",
  folder: "/home/neo",
  prompt: "tidy it",
  goalKind: "command",
  goalCommand: "true",
  triggerKind: "cron",
  cronExpr: "0 6 * * *",
  maxIterations: 3,
  budgetUsd: 2,
  enabledByDefault: true,
  ...over,
});

function fileWith(dir: string, body: unknown, name = "loop.json"): string {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), "utf-8");
  return path;
}

test("parseArgs needs an input file and defaults to the daemon's ledger", () => {
  expect(parseArgs([])).toEqual({ error: expect.stringContaining("usage:") });
  expect(parseArgs(["loop.json"])).toEqual({ file: "loop.json", ledgerPath: LEDGER_PATH, update: false });
});

test("parseArgs reads --update and --ledger", () => {
  expect(parseArgs(["loop.json", "--update", "--ledger", "/tmp/x.db"])).toEqual({
    file: "loop.json",
    ledgerPath: "/tmp/x.db",
    update: true,
  });
  expect(parseArgs(["loop.json", "--ledger"])).toEqual({ error: expect.stringContaining("--ledger") });
  expect(parseArgs(["loop.json", "--wat"])).toEqual({ error: expect.stringContaining("--wat") });
});

test("applyLoopFile persists a loop the scheduler's effectiveLoops then sees", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "ledger.db");
  const res = applyLoopFile({ file: fileWith(dir, input()), ledgerPath, update: false });
  expect(res).toMatchObject({ ok: true });

  const stored = effectiveLoops(openLedger(ledgerPath)).find((l) => l.name === "tidy-up");
  expect(stored).toMatchObject({
    name: "tidy-up",
    folder: "/home/neo",
    trigger: { kind: "cron", expr: "0 6 * * *" },
    bounds: { maxIterations: 3, budgetUsd: 2 },
    enabledByDefault: true,
  });
});

test("applyLoopFile reports a validation error instead of writing (folder fence)", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "ledger.db");
  const res = applyLoopFile({ file: fileWith(dir, input({ folder: "/etc" })), ledgerPath, update: false });
  expect(res).toEqual({ ok: false, error: expect.stringContaining("existing directory under") });
  expect(openLedger(ledgerPath).listLoopDefs()).toEqual([]);
});

test("applyLoopFile refuses to clobber an existing loop unless --update is given", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "ledger.db");
  expect(applyLoopFile({ file: fileWith(dir, input()), ledgerPath, update: false })).toMatchObject({ ok: true });

  const second = fileWith(dir, input({ summary: "tidy harder" }), "loop2.json");
  expect(applyLoopFile({ file: second, ledgerPath, update: false })).toEqual({
    ok: false,
    error: expect.stringContaining("already exists"),
  });
  expect(applyLoopFile({ file: second, ledgerPath, update: true })).toMatchObject({ ok: true });
  expect(effectiveLoops(openLedger(ledgerPath)).find((l) => l.name === "tidy-up")?.summary).toBe("tidy harder");
});

test("applyLoopFile reports unreadable/unparseable input as an error, never a throw", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "ledger.db");
  expect(applyLoopFile({ file: fileWith(dir, "{not json"), ledgerPath, update: false })).toMatchObject({ ok: false });
  expect(applyLoopFile({ file: join(dir, "missing.json"), ledgerPath, update: false })).toMatchObject({ ok: false });
});
