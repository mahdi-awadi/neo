// The metrics snapshot (W0.7) reads a real ledger, written through the engine's own code, and only reads.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { metricsSnapshot, openReadOnly, renderSnapshot } from "../tools/metrics-snapshot";

function ledgerWith(): { path: string; from: number; to: number } {
  const dir = mkdtempSync(join(tmpdir(), "neo-metrics-"));
  const path = join(dir, "ledger.db");
  const ledger = openLedger(path);
  const t = 1_700_000_000_000;
  ledger.recordEvent("dispatch_end", { orderId: "o1", sessionId: "s1", folder: "/home/a", data: { project: "a", ok: true, costUsd: 1.5 }, at: t + 1000 });
  ledger.recordEvent("dispatch_end", { orderId: "o2", sessionId: "s2", folder: "/home/a", data: { project: "a", ok: false, costUsd: 0.5 }, at: t + 2000 });
  ledger.recordEvent("dispatch_end", { orderId: "o3", sessionId: "s3", folder: "/home/b", data: { project: "b", ok: true, costUsd: 2 }, at: t - 86_400_000 }); // outside the window
  ledger.recordEvent("dispatch_start", { orderId: "o1", at: t + 500 }); // another kind: never counted
  ledger.openDecision({ kind: "decision", orderId: "o1", question: "which?" }, t + 1100); // ask_operator on o1
  ledger.openDecision({ kind: "decision", sessionId: "s2", question: "approve?" }, t + 2100); // governor approval, no order
  ledger.openDecision({ kind: "decision", orderId: "zz", question: "unrelated" }, t + 2200); // not a dispatch in the window
  ledger.openDecision({ kind: "alert", orderId: "o1", question: "boom" }, t + 2300); // alerts are not interventions
  return { path, from: t, to: t + 10_000 };
}

test("the snapshot counts the window's dispatches, their usage proxy and the interventions on them", () => {
  const { path, from, to } = ledgerWith();
  const s = metricsSnapshot(openReadOnly(path), { from, to });
  expect(s.dispatches).toEqual({ count: 2, ok: 1, failed: 1, estUsageUnits: 2, estUsageUnitsPerDispatch: 1 });
  expect(s.interventions).toEqual({ decisions: 1, approvals: 1, perDispatch: 1 });
  expect(Object.keys(s.pending)).toEqual(["claimVsVerdictRate", "tokensPerVerifiedTask", "reopenedIncidents", "mergedPrsPerWeek", "windowShare"]);
  for (const v of Object.values(s.pending)) expect(v).toMatch(/^n\/a until W\d/);
});

test("an empty window reports zeros and no per-dispatch number", () => {
  const { path } = ledgerWith();
  const s = metricsSnapshot(openReadOnly(path), { from: 1, to: 2 });
  expect(s.dispatches).toEqual({ count: 0, ok: 0, failed: 0, estUsageUnits: 0, estUsageUnitsPerDispatch: null });
  expect(s.interventions).toEqual({ decisions: 0, approvals: 0, perDispatch: null });
  expect(renderSnapshot(s)).toContain("per dispatch —");
});

test("the tool only reads: a write through its handle is refused, and a missing ledger is an error", () => {
  const { path } = ledgerWith();
  const db = openReadOnly(path) as unknown as { run(sql: string): void };
  expect(() => db.run("DELETE FROM events")).toThrow();
  expect(() => openReadOnly(join(tmpdir(), "nope", "ledger.db"))).toThrow(/no ledger/);
});

test("renderSnapshot is one line per number and names what each pending line waits for", () => {
  const { path, from, to } = ledgerWith();
  const text = renderSnapshot(metricsSnapshot(openReadOnly(path), { from, to }));
  expect(text).toContain("dispatches: 2 (ok 1, failed 1)");
  expect(text).toContain("interventions: decisions 1, approvals 1");
  expect(text).toContain("mergedPrsPerWeek: n/a until W3.6");
});
