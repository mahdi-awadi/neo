// ADR-0045 one-off: supersede the decisions found done, cancel their parked todos, finish a built plan,
// seed the kept asks, re-derive the threads — and a second run changes nothing.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import { run } from "../tools/oneoff/2026-10-22-close-done-waiting-threads";

test("AC6: done decisions closed with their evidence, kept ones seeded, threads re-derived, idempotent", () => {
  const path = join(mkdtempSync(join(tmpdir(), "oneoff-")), "ledger.db");
  const led = openLedger(path);
  const t = createTrace({ ledger: led, registry: createRegistry() });
  const a = t.inbound({ chatId: 7, text: "build sos", surface: "telegram" });
  const b = t.inbound({ chatId: 7, text: "build wallet", surface: "telegram" });
  const done = led.openDecision({ kind: "decision", question: "Ship it?", cause: a, folder: "/f" }, 1_000);
  const plan = led.openDecision({ kind: "decision", question: "Plan waiting for your approval: docs/sos.md", cause: a, folder: "/f" }, 1_000);
  led.upsertPlan({ project: "p", folder: "/f", title: "t", sha256: "x", stepsTotal: 1, stepsDone: 0, threadId: a.threadId, createdAt: 1_000, updatedAt: 1_000, path: "docs/sos.md", status: "sent", decisionId: plan } as never);
  const todo = led.addTodo({ project: "p", folder: "/f", brief: "continue", workClass: "interactive", createdBy: "operator", cause: a }, 1_000);
  led.updateTodo(todo.id, { status: "waiting", waitingOn: done });
  const kept = led.openDecision({ kind: "decision", question: "Which bank?", cause: b, folder: "/f" }, 1_000);
  t.refreshThread(a.threadId);
  t.refreshThread(b.threadId);
  expect(led.threadById(a.threadId)?.state).toBe("waiting");

  const db = new Database(path);
  const opts = { fixes: [{ id: done.slice(0, 8), reason: "shipped in abc123" }, { id: plan.slice(0, 8), reason: "built in def456" }], keeps: [{ id: kept.slice(0, 8), ask: "Pick the bank" }], now: 5_000 };
  const dry = run(db, { ...opts, apply: false });
  expect(dry.filter((l) => l.includes("→ superseded")).length).toBe(2);
  expect(led.decisionById(done)?.status).toBe("open"); // dry run wrote nothing

  const out = run(db, { ...opts, apply: true });
  expect(led.decisionById(done)).toMatchObject({ status: "superseded", answer: "done by later work: shipped in abc123" });
  expect(led.decisionById(plan)?.status).toBe("superseded");
  expect(led.todoById(todo.id)?.status).toBe("cancelled");
  expect(led.planById(led.listPlans("p")[0]!.id)?.status).toBe("done");
  expect(led.threadById(a.threadId)?.state).toBe("done");
  expect(led.threadById(b.threadId)?.state).toBe("waiting");
  expect((led.getMeta("waitingSweep.judged")?.value as Record<string, { ask: string }>)[kept]?.ask).toBe("Pick the bank");
  expect(out).toContain(`thread ${t.ref(a.threadId)}: waiting → done`);

  const again = run(db, { ...opts, apply: true });
  expect(again.filter((l) => l.includes("already superseded")).length).toBe(2);
  expect(again.some((l) => l.startsWith("thread "))).toBe(false);
});
