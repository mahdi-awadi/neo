// P4 Task 4.2 (ADR-0018, spec §7 + §8): the engine producer — what the engine itself knows needs the
// operator, read from the ledger and the registry only. One test per kind, with a fake clock.
import { test, expect } from "bun:test";
import { openLedger, type Ledger, type ThreadState } from "../src/engine/ledger";
import { createRegistry, type Registry } from "../src/engine/registry";
import { listOpen } from "../src/engine/attention";
import { engineDrafts, runEngineProducer, readAttentionCfg, ENGINE_KINDS, type EngineProducerDeps } from "../src/engine/producers/engine";
import type { Order } from "../src/types";

const H = 3_600_000;
const T0 = 1_000 * H;

function setup(over: Partial<EngineProducerDeps> = {}) {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const deps: EngineProducerDeps = {
    ledger,
    registry,
    cfg: { ...readAttentionCfg(undefined), approvalRemindMs: 30 * 60_000, companyFolder: "/home/neo/agent" },
    ...over,
  };
  return { ledger, registry, deps };
}

function session(registry: Registry, folder: string) {
  const order: Order = { id: crypto.randomUUID(), source: "neo", folder, task: "t", chatId: 1, createdAt: 0 };
  const s = registry.add(order, 0);
  registry.setStatus(s.id, "running");
  return s;
}

function thread(l: Ledger, o: { project?: string; folder?: string; state: ThreadState; at: number }): number {
  const id = l.insertMessage({ chatId: 1, role: "user", content: "fix the fare list", at: o.at, surface: "web" });
  l.insertThread({ id, origin: "operator", title: "fix the fare list", state: o.state, createdAt: o.at, project: o.project, folder: o.folder });
  l.setMessageThread(id, id);
  l.touchThread(id, id, o.at);
  return id;
}

const kinds = (deps: EngineProducerDeps, now: number) => engineDrafts(deps, now).map((d) => d.kind);

test("approval_stuck: an approval pending longer than approvalRemindMs is a high item; a fresh one is not", () => {
  const { registry, deps } = setup();
  const s = session(registry, "/home/gold");
  registry.noteBlocked(s.id, { kind: "approval", label: "Bash: rm -rf build", since: T0 });
  expect(kinds(deps, T0 + 10 * 60_000)).toEqual([]);
  const [d] = engineDrafts(deps, T0 + 31 * 60_000);
  expect(d).toMatchObject({ project: s.name, folder: "/home/gold", source: "engine", kind: "approval_stuck", severity: "high" });
  expect(d!.title).toContain("Bash: rm -rf build");
  // A decision block is not an approval.
  registry.noteBlocked(s.id, { kind: "decision", label: "ship?", since: T0 });
  expect(kinds(deps, T0 + 31 * 60_000)).toEqual([]);
});

test("queue_paused: a todo queue paused longer than queuePausedHours", () => {
  const { ledger, deps } = setup();
  ledger.setTodoPaused("/home/gold", "a todo failed", T0);
  expect(kinds(deps, T0 + 5 * H)).toEqual([]);
  const [d] = engineDrafts(deps, T0 + 7 * H);
  expect(d).toMatchObject({ project: "gold", folder: "/home/gold", kind: "queue_paused", key: "/home/gold", severity: "normal" });
  expect(d!.title).toContain("a todo failed");
});

test("thread_failed: a failed thread inside the lookback; an older one ages out", () => {
  const { ledger, deps } = setup();
  const id = thread(ledger, { project: "gold", folder: "/home/gold", state: "failed", at: T0 });
  const [d] = engineDrafts(deps, T0 + H);
  expect(d).toMatchObject({ project: "gold", folder: "/home/gold", kind: "thread_failed", key: String(id) });
  expect(kinds(deps, T0 + (deps.cfg.failedLookbackHours + 1) * H)).toEqual([]);
});

test("thread_waiting: a thread waiting longer than waitingHours; a recent one is not", () => {
  const { ledger, deps } = setup();
  thread(ledger, { project: "gold", folder: "/home/gold", state: "waiting", at: T0 });
  expect(kinds(deps, T0 + 11 * H)).toEqual([]);
  expect(kinds(deps, T0 + 13 * H)).toEqual(["thread_waiting"]);
});

test("decision_stale: an open decision older than decisionStaleHours; no project → the company", () => {
  const { ledger, deps } = setup();
  ledger.openDecision({ kind: "decision", question: "ship the fare list?", project: "gold", folder: "/home/gold" }, T0);
  ledger.openDecision({ kind: "decision", question: "which repo?" }, T0);
  ledger.openDecision({ kind: "alert", question: "disk 90%" }, T0);
  expect(kinds(deps, T0 + 23 * H)).toEqual([]);
  const ds = engineDrafts(deps, T0 + 25 * H);
  expect(ds.map((d) => [d.kind, d.project, d.folder])).toEqual([
    ["decision_stale", "gold", "/home/gold"],
    ["decision_stale", "agent", "/home/neo/agent"],
  ]);
});

test("ctx_window_suspect: occupancy over 1 names the model and the window; a sane one is quiet", () => {
  let occ = 0.5;
  const { registry, deps } = setup({ measure: () => ({ occupancy: occ, model: "claude-opus-5-5", windowTokens: 200_000 }) });
  const s = session(registry, "/home/gold");
  registry.setSdkSessionId(s.id, "sdk-1");
  expect(kinds(deps, T0)).toEqual([]);
  occ = 1.4;
  const [d] = engineDrafts(deps, T0);
  expect(d).toMatchObject({ project: s.name, kind: "ctx_window_suspect", key: "/home/gold" });
  expect(d!.title).toContain("claude-opus-5-5");
  expect(d!.title).toContain("200000");
  expect(d!.title).toContain("140%");
});

test("a measure that throws costs only its own kind, never the other items", () => {
  const { ledger, registry, deps } = setup({ measure: () => { throw new Error("transcript unreadable"); } });
  const s = session(registry, "/home/gold");
  registry.setSdkSessionId(s.id, "sdk-1");
  ledger.setTodoPaused("/home/gold", "a todo failed", T0);
  expect(kinds(deps, T0 + 7 * H)).toEqual(["queue_paused"]);
});

test("runEngineProducer reconciles: items open, then resolve when the cause is gone", () => {
  const { ledger, deps } = setup();
  ledger.setTodoPaused("/home/gold", "a todo failed", T0);
  runEngineProducer(deps, T0 + 7 * H);
  expect(listOpen(ledger, { now: T0 + 7 * H }).map((r) => r.kind)).toEqual(["queue_paused"]);
  ledger.setTodoPaused("/home/gold", null);
  runEngineProducer(deps, T0 + 8 * H);
  expect(listOpen(ledger, { now: T0 + 8 * H })).toEqual([]);
});

test("a kind whose read fails keeps its open items (no false resolve); the other kinds still reconcile", () => {
  let broken = false;
  const { ledger, registry, deps } = setup({
    measure: () => {
      if (broken) throw new Error("transcript unreadable");
      return { occupancy: 1.4, model: "m", windowTokens: 200_000 };
    },
  });
  const s = session(registry, "/home/gold");
  registry.setSdkSessionId(s.id, "sdk-1");
  ledger.setTodoPaused("/home/gold", "a todo failed", T0);
  runEngineProducer(deps, T0 + 7 * H);
  expect(listOpen(ledger, { now: T0 + 7 * H }).map((r) => r.kind).sort()).toEqual(["ctx_window_suspect", "queue_paused"]);
  broken = true;
  ledger.setTodoPaused("/home/gold", null);
  runEngineProducer(deps, T0 + 8 * H);
  expect(listOpen(ledger, { now: T0 + 8 * H }).map((r) => r.kind)).toEqual(["ctx_window_suspect"]);
});

test("every kind the producer emits is listed in ENGINE_KINDS", () => {
  expect([...ENGINE_KINDS].sort()).toEqual(["approval_stuck", "ctx_window_suspect", "decision_stale", "queue_paused", "thread_failed", "thread_waiting"]);
});

test("readAttentionCfg: defaults, and only well-typed positive numbers are kept", () => {
  expect(readAttentionCfg(undefined)).toEqual({ queuePausedHours: 6, waitingHours: 12, decisionStaleHours: 24, failedLookbackHours: 72 });
  expect(readAttentionCfg({ waitingHours: 2, decisionStaleHours: "x", queuePausedHours: -1 })).toMatchObject({ waitingHours: 2, decisionStaleHours: 24, queuePausedHours: 6 });
});
