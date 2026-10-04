// The wiring half of the liveness fix: the engine must FEED the one authoritative clock from every
// worker path, mark a session blocked while the operator owes it an answer, and never stall-abort
// such a session. (The judgement itself is unit-tested in liveness.test.ts.)
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dispatchToProject, raiseOperatorDecision, type DispatchDeps } from "../src/engine/dispatch";
import { clearDecisionBlock, stateOf } from "../src/engine/session-status";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";

const NEVER = new Promise<RunResult>(() => {});
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function makeDeps(over: Partial<DispatchDeps> = {}) {
  const replies: Array<{ text: string; project?: string }> = [];
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text, project) => void replies.push({ text, project }),
    askApproval: async () => "deny",
    ...over,
  };
  return { d, replies };
}

function projectRoot() {
  const root = mkdtempSync(join(tmpdir(), "neo-live-"));
  mkdirSync(join(root, "acme"));
  return root;
}

/** A fake worker whose handlers the test can drive, and whose run never finishes on its own. */
function capturingStart() {
  let handlers!: RunHandlers;
  const start = (_o: unknown, h: RunHandlers) => {
    handlers = h;
    return {
      followUp: () => {},
      queued: () => 0,
      active: () => true,
      interrupt: async () => {},
      close: () => {},
      done: NEVER,
    };
  };
  return { start, handlers: () => handlers };
}

test("a dispatched worker's heartbeat advances the registry's activity clock", async () => {
  const root = projectRoot();
  const { d } = makeDeps();
  const cap = capturingStart();
  let clock = 1_000;
  await dispatchToProject("acme", "task", d, 1, { start: cap.start as never, now: () => clock, root });
  await settle();

  const s = d.registry.findByFolder(join(root, "acme"))!;
  expect(s.lastActivityAt).toBe(1_000);
  clock = 7_000;
  cap.handlers().onHeartbeat!(); // a partial generation delta — alive, nothing operator-visible
  expect(d.registry.get(s.id)!.lastActivityAt).toBe(7_000);
});

test("a dispatched worker's operator-visible line advances the OUTPUT clock too", async () => {
  const root = projectRoot();
  const { d } = makeDeps();
  const cap = capturingStart();
  let clock = 1_000;
  await dispatchToProject("acme", "task", d, 1, { start: cap.start as never, now: () => clock, root });
  await settle();
  const s = d.registry.findByFolder(join(root, "acme"))!;

  clock = 5_000;
  cap.handlers().onHeartbeat!();
  expect(d.registry.get(s.id)!.lastOutputAt).toBeLessThan(5_000); // a heartbeat is not output

  clock = 9_000;
  cap.handlers().onMessage("here is what I found");
  expect(d.registry.get(s.id)!.lastOutputAt).toBe(9_000);
  expect(d.registry.get(s.id)!.lastActivityAt).toBe(9_000);
});

test("a dispatched worker waiting on an approval is marked awaiting-operator, then cleared", async () => {
  const root = projectRoot();
  let release!: (v: "allow" | "deny") => void;
  const pending = new Promise<"allow" | "deny">((r) => (release = r));
  const { d } = makeDeps({ askApproval: () => pending });
  const cap = capturingStart();
  await dispatchToProject("acme", "task", d, 1, { start: cap.start as never, now: () => 1_000, root });
  await settle();
  const s = d.registry.findByFolder(join(root, "acme"))!;

  const verdict = cap.handlers().onEscalation("Write outside project");
  await settle(1);
  expect(d.registry.get(s.id)!.blockedOn).toMatchObject({ kind: "approval", label: "Write outside project" });

  release("allow");
  expect(await verdict).toBe("allow");
  await settle(1);
  expect(d.registry.get(s.id)!.blockedOn).toBeUndefined();
});

test("a dispatch is NEVER stall-aborted while its worker waits on the operator", async () => {
  const root = projectRoot();
  const { d } = makeDeps({ askApproval: () => new Promise<"allow" | "deny">(() => {}) });
  d.dispatchStallMs = 40;
  d.dispatchGraceMs = 20;
  const cap = capturingStart();
  // real clock: the stall monitor measures elapsed time
  await dispatchToProject("acme", "task", d, 1, { start: cap.start as never, root });
  await settle();
  void cap.handlers().onEscalation("Write outside project");
  await settle(1);

  await settle(250); // ≫ the 40ms stall window below
  const kinds = d.ledger.listEvents({ limit: 50 }).map((e) => e.kind);
  expect(kinds).not.toContain("dispatch_abort");
}, 10_000);

test("a stall abort records the evidence it acted on BEFORE it fires", async () => {
  const root = projectRoot();
  const { d } = makeDeps();
  d.dispatchStallMs = 40;
  d.dispatchGraceMs = 20;
  const cap = capturingStart();
  await dispatchToProject("acme", "task", d, 1, { start: cap.start as never, root });
  await settle();
  cap.handlers().onActivity!("Bash: cp -i src dst");

  await settle(400);
  const events = d.ledger.listEvents({ limit: 50 });
  const kinds = events.map((e) => e.kind);
  expect(kinds).toContain("dispatch_stall_evidence");
  expect(kinds).toContain("dispatch_abort");
  const ev = d.ledger.listEvents({ kind: "dispatch_stall_evidence" })[0];
  expect(ev.data).toMatchObject({ limit: "stall", state: "wedged", activity: "Bash: cp -i src dst", stdinWait: true });
}, 10_000);

test("raising a decision marks that folder's session awaiting-operator", async () => {
  const folder = "/p/acme";
  const { d } = makeDeps({ postDecision: async () => ({ chatId: 9, messageId: 1 }) });
  const s = d.registry.add({ id: "o-live", source: "neo", folder, task: "t", chatId: -2, createdAt: 0 }, 0);
  d.registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => true });

  // raiseOperatorDecision is the ONE path behind every blocking ask — `ask_operator` and the
  // serviced native AskUserQuestion both land here, so marking it here can't be forgotten.
  await raiseOperatorDecision(d, { project: "acme", folder, chatId: 1, question: "Postgres or Mongo?", now: () => 0 });

  expect(d.registry.get(s.id)!.blockedOn).toMatchObject({ kind: "decision", label: "Postgres or Mongo?", since: 0 });
  expect(stateOf(d.registry, d.registry.get(s.id)!, 10 * 60 * 1000)).toBe("awaiting-operator");
});

test("raising a decision for a folder with no live session is harmless", async () => {
  const { d } = makeDeps({ postDecision: async () => ({ chatId: 9, messageId: 1 }) });
  const id = await raiseOperatorDecision(d, { folder: "/p/nothing-open", chatId: 1, question: "q?" });
  expect(id).toBeTruthy();
});

// A brief arriving answers a raised DECISION (or supersedes it). It does NOT answer a pending
// permission escalation — that approval is still suspending the worker mid-tool, and clearing it
// would hand the stall monitor a worker that is still legitimately waiting.
test("delivering a brief clears a raised decision but never a pending approval", async () => {
  const folder = "/p/acme";
  const { d } = makeDeps();
  const s = d.registry.add({ id: "o-clear", source: "neo", folder, task: "t", chatId: -2, createdAt: 0 }, 0);

  d.registry.noteBlocked(s.id, { kind: "decision", label: "Postgres or Mongo?", since: 0 });
  clearDecisionBlock(d.registry, s.id);
  expect(d.registry.get(s.id)!.blockedOn).toBeUndefined();

  d.registry.noteBlocked(s.id, { kind: "approval", label: "Write outside project", since: 0 });
  clearDecisionBlock(d.registry, s.id);
  expect(d.registry.get(s.id)!.blockedOn).toMatchObject({ kind: "approval" });
});

// A dispatch landing on a project that is blocked on the operator must say THAT — "is working"
// would send the company looking for progress that cannot happen until the operator answers.
test("dispatch to a project awaiting the operator names that state, not 'working'", async () => {
  const root = projectRoot();
  const folder = join(root, "acme");
  const { d } = makeDeps();
  const s = d.registry.add({ id: "o-blocked", source: "neo", folder, task: "t", chatId: -2, createdAt: 0 }, 0);
  d.registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => true });
  d.registry.noteBlocked(s.id, { kind: "decision", label: "Postgres or Mongo?", since: 0 });

  const out = await dispatchToProject("acme", "next task", d, 1, {
    start: (() => {
      throw new Error("must not start");
    }) as never,
    root,
    now: () => 60_000,
  });
  expect(out).toContain("awaiting-operator");
  expect(out).not.toContain("is working");
});
