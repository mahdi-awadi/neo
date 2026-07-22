// Wiring for the rate-limit policy: an interactive session and a dispatched sub-run both retry a
// throttled turn (backoff + resumed follow-up), and the engine-wide cooldown holds NEW background
// work while a throttle is fresh. Clock/sleep/rand injected — no real timers.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleMessage, type PipelineDeps } from "../src/engine/pipeline";
import { dispatchToProject, type DispatchDeps } from "../src/engine/dispatch";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { createApiCooldown, MAX_API_RETRIES } from "../src/engine/api-retry";
import { loadConfig } from "../src/config";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";

const scratch = () => mkdtempSync(join(tmpdir(), "neo-apiretry-"));
const cfg = () => loadConfig(scratch());

// A fake worker whose turns we drive by hand, recording what gets pushed back into it.
function fakeWorker() {
  let handlers: RunHandlers | undefined;
  const followUps: string[] = [];
  let closed = false;
  const start = (_o: Order, h: RunHandlers): SessionRun => {
    handlers = h;
    return {
      followUp: (t) => void followUps.push(t),
      interrupt: async () => {},
      queued: () => 0,
      close: () => void (closed = true),
      done: new Promise<RunResult>(() => {}),
    };
  };
  return {
    start,
    followUps,
    closed: () => closed,
    /** Fire a turn boundary that ended on an API failure. */
    throttledTurn: (kind: "rate_limit" | "billing_error" = "rate_limit") =>
      handlers?.onTurnComplete?.({ ok: false, sessionId: "s1", summary: "API Error", costUsd: 0, apiError: kind }),
  };
}

// --- interactive sessions -------------------------------------------------------------------------

function pipelineHarness(over: Partial<PipelineDeps> = {}) {
  const replies: string[] = [];
  const deps: PipelineDeps = {
    cfg: cfg(),
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, t) => void replies.push(t),
    askApproval: async () => "allow" as const,
    ...over,
  };
  return { replies, deps };
}

test("a throttled turn re-sends the SAME brief into the session after the backoff", async () => {
  const dir = scratch();
  const w = fakeWorker();
  const slept: number[] = [];
  const { replies, deps } = pipelineHarness({
    start: w.start as never,
    sleep: async (ms: number) => void slept.push(ms),
    rand: () => 0.5,
  } as Partial<PipelineDeps>);

  await handleMessage(`/open ${dir} port the NDC classes`, 9, deps);
  await w.throttledTurn();
  await new Promise((r) => setTimeout(r, 0)); // let the retry continuation run

  expect(replies.some((t) => t.includes(`1/${MAX_API_RETRIES}`) && t.includes("30s"))).toBe(true);
  expect(slept).toEqual([30_000]); // waited the first backoff step, not a fixed poll
  expect(w.followUps.length).toBe(1);
  expect(w.followUps[0]).toContain("port the NDC classes"); // the original brief, re-sent
  expect(w.followUps[0].toLowerCase()).toContain("already"); // warned the attempt may be half-done
});

test("retries stop at the cap and the operator is told the work is NOT done", async () => {
  const dir = scratch();
  const w = fakeWorker();
  const { replies, deps } = pipelineHarness({
    start: w.start as never,
    sleep: async () => {},
    rand: () => 0.5,
  } as Partial<PipelineDeps>);

  await handleMessage(`/open ${dir} do the thing`, 9, deps);
  for (let i = 0; i <= MAX_API_RETRIES; i++) {
    await w.throttledTurn();
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(w.followUps.length).toBe(MAX_API_RETRIES); // no endless retrying
  expect(replies.some((t) => t.toLowerCase().includes("not done"))).toBe(true);
});

test("a non-retryable API failure is reported, never retried", async () => {
  const dir = scratch();
  const w = fakeWorker();
  const { replies, deps } = pipelineHarness({
    start: w.start as never,
    sleep: async () => {},
    rand: () => 0.5,
  } as Partial<PipelineDeps>);

  await handleMessage(`/open ${dir} do the thing`, 9, deps);
  await w.throttledTurn("billing_error");
  await new Promise((r) => setTimeout(r, 0));
  expect(w.followUps.length).toBe(0);
  expect(replies.some((t) => t.includes("billing_error"))).toBe(true);
});

// --- dispatched sub-runs ---------------------------------------------------------------------------

function dispatchHarness() {
  const replies: string[] = [];
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text) => void replies.push(text),
    askApproval: async () => "deny",
  };
  return { d, replies };
}

test("a throttled sub-run retries instead of closing as if it had finished", async () => {
  const root = scratch();
  mkdirSync(join(root, "eticket-v3"));
  const { d, replies } = dispatchHarness();
  const w = fakeWorker();
  await dispatchToProject("eticket-v3", "fix the partner leak", d, 1, {
    start: w.start as never,
    now: () => 0,
    root,
    sleep: async () => {},
    rand: () => 0.5,
  } as never);

  await w.throttledTurn();
  await new Promise((r) => setTimeout(r, 0));
  expect(w.closed()).toBe(false); // NOT treated as a completed sub-run
  expect(w.followUps.length).toBe(1);
  expect(w.followUps[0]).toContain("fix the partner leak");
  expect(replies.some((t) => t.includes(`1/${MAX_API_RETRIES}`))).toBe(true);
});

test("while the cooldown is armed a new dispatch is held, not started", async () => {
  const root = scratch();
  mkdirSync(join(root, "eticket-v3"));
  const { d } = dispatchHarness();
  const cooldown = createApiCooldown({ cooldownMs: 60_000 });
  cooldown.note("rate_limit", 0);
  const out = await dispatchToProject("eticket-v3", "task", { ...d, cooldown }, 1, {
    start: (() => {
      throw new Error("must not start a worker during a throttle");
    }) as never,
    now: () => 10_000,
    root,
  } as never);
  expect(out.toLowerCase()).toContain("hold");
  expect(out).toContain("50s"); // what's left of the window
});

test("once the cooldown elapses dispatch runs normally again", async () => {
  const root = scratch();
  mkdirSync(join(root, "eticket-v3"));
  const { d } = dispatchHarness();
  const cooldown = createApiCooldown({ cooldownMs: 60_000 });
  cooldown.note("rate_limit", 0);
  const w = fakeWorker();
  const out = await dispatchToProject("eticket-v3", "task", { ...d, cooldown }, 1, {
    start: w.start as never,
    now: () => 60_001,
    root,
  } as never);
  expect(out).toContain("dispatched to");
});

test("a throttled sub-run arms the shared cooldown so sibling work backs off too", async () => {
  const root = scratch();
  mkdirSync(join(root, "eticket-v3"));
  const { d } = dispatchHarness();
  const cooldown = createApiCooldown({ cooldownMs: 60_000 });
  const w = fakeWorker();
  await dispatchToProject("eticket-v3", "task", { ...d, cooldown }, 1, {
    start: w.start as never,
    now: () => 1_000,
    root,
    sleep: async () => {},
    rand: () => 0.5,
  } as never);
  expect(cooldown.activeAt(1_000)).toBe(false);
  await w.throttledTurn();
  expect(cooldown.activeAt(1_000)).toBe(true);
});
