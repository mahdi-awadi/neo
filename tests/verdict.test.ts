// The verdict (W1.3): one pure rule from claim + run end + gate.
import { test, expect } from "bun:test";
import { assignVerdict, verdictLine, type GateResult } from "../src/engine/verdict";
import type { Claim } from "../src/engine/report-tool";

const ready: Claim = { status: "ready", summary: "Done.", ran: [{ cmd: "bun test", exit: 0 }], changed: ["a.ts"], ref: { commit: "abc1234" }, risks: [], assumptions: [], evidence: [] };
const gate = (over: Partial<GateResult> = {}): GateResult => ({ ran: true, declared: 2, passed: 2, failed: [], stale: false, dirty: [], policyChanged: [], headSha: "deadbeef0000", ...over });

test("no claim → unreported, whether the run ended well or badly", () => {
  expect(assignVerdict({ runOk: true })).toMatchObject({ verdict: "unreported", disagree: false });
  expect(assignVerdict({ runOk: false, failure: "stall" }).reason).toContain("stall");
});

test("ready is earned: the gate must pass, the tree must be committed, the policy must be unchanged, the run must have ended well", () => {
  expect(assignVerdict({ claim: ready, runOk: true, gate: gate() })).toEqual({ verdict: "ready", reason: "2/2 checks passed", disagree: false });
  expect(assignVerdict({ claim: ready, runOk: true, gate: gate({ passed: 1, failed: [{ cmd: "bun test", exit: 1, tail: "x" }] }) })).toMatchObject({ verdict: "failed", reason: "bun test exited 1", disagree: true });
  expect(assignVerdict({ claim: ready, runOk: true, gate: gate({ dirty: ["a.ts", "b.ts"] }) })).toMatchObject({ verdict: "blocked", reason: expect.stringContaining("uncommitted changes in 2 files") });
  expect(assignVerdict({ claim: ready, runOk: true, gate: gate({ policyChanged: ["package.json"] }) })).toMatchObject({ verdict: "blocked", reason: expect.stringContaining("package.json") });
  expect(assignVerdict({ claim: ready, runOk: false, failure: "api:rate_limit" })).toMatchObject({ verdict: "failed", disagree: true });
  expect(assignVerdict({ claim: ready, runOk: true, gate: gate({ ran: false, error: "not a git repository" }) })).toMatchObject({ verdict: "blocked", reason: expect.stringContaining("could not run") });
});

test("stale beats everything, and no checks declared leaves the claim standing but says it is unverified", () => {
  expect(assignVerdict({ claim: ready, runOk: true, gate: gate({ stale: true }) })).toMatchObject({ verdict: "stale", disagree: true });
  expect(assignVerdict({ runOk: true, gate: gate({ stale: true }) }).verdict).toBe("stale");
  expect(assignVerdict({ claim: ready, runOk: true, gate: gate({ ran: false, declared: 0 }) })).toEqual({ verdict: "ready", reason: "no checks declared — the claim stands unverified", disagree: false });
  expect(assignVerdict({ claim: ready, runOk: true })).toMatchObject({ verdict: "ready", reason: expect.stringContaining("unverified") });
});

test("a non-ready claim stands as the worker said it", () => {
  const blocked: Claim = { ...ready, status: "blocked", ran: [], summary: "Need the staging password." };
  expect(assignVerdict({ claim: blocked, runOk: true, gate: gate({ failed: [{ cmd: "x", exit: 1, tail: "" }] }) })).toEqual({ verdict: "blocked", reason: "Need the staging password.", disagree: false });
  const handback: Claim = { ...ready, status: "handback", ran: [], handback: { reason: "billing's change" } };
  expect(assignVerdict({ claim: handback, runOk: true }).verdict).toBe("handback");
});

test("verdictLine shows both words when they differ", () => {
  const v = assignVerdict({ claim: ready, runOk: true, gate: gate({ passed: 1, failed: [{ cmd: "bun test", exit: 1, tail: "" }] }) });
  expect(verdictLine(v, ready)).toBe("claim ready ≠ verdict failed: bun test exited 1");
  expect(verdictLine(assignVerdict({ claim: ready, runOk: true, gate: gate() }), ready)).toBe("verdict ready (2/2 checks passed)");
  expect(verdictLine(assignVerdict({ runOk: true }))).toBe("verdict unreported (the worker ended without calling `report`)");
});
