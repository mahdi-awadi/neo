// ADR-0029: after a handoff the engine always says (and does) what happens next — continue, wait on
// a decision, or idle — and Neo's note lives outside the repo, never in the project's HANDOFF.md.
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  nextAfterHandoff,
  encodeCwd,
  describeContextReset,
  neoNotePath,
  setNeoNotesDir,
  finalizeHandoffNote,
  writeIdleStateNote,
  handoffPreamble,
  handoffPrompt,
  checkpointSteer,
  type ContextPolicyCfg,
} from "../src/engine/context-policy";
import { steerAllows } from "../src/engine/context-checkpoint";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { dispatchToProject, type DispatchDeps } from "../src/engine/dispatch";
import type { RunResult } from "../src/engine/session-runner";
import { createTodoQueue } from "../src/engine/todo-queue";
import { answerDecision } from "../src/engine/reply-routing";
import { dashboardSnapshot } from "../src/engine/dashboard";
import { handleCommand } from "../src/engine/commands";

const NOTES = mkdtempSync(join(tmpdir(), "neo-notes-"));
setNeoNotesDir(NOTES);
afterEach(() => setNeoNotesDir(NOTES));

const NOTE_MORE = "## Goal\nPhase 4\n## Done\n4.1–4.8\n## Next steps\n1. Phase 5: wallet ledger\n2. Phase 6\n## Open decisions\nnone\n";
const NOTE_DONE = "## Goal\nPhase 4\n## Done\nall\n## Next steps\nNone — the plan is complete.\n## Open decisions\nnone\n";

// --- the pure rule -----------------------------------------------------------------------------

test("nextAfterHandoff: an open decision this run raised wins over more work (never spin)", () => {
  const r = nextAfterHandoff({ note: NOTE_MORE, openDecisions: [{ id: "f6193fc8-508b", question: "What may /public show?" }] });
  expect(r).toEqual({ kind: "blocked", decision: { id: "f6193fc8-508b", question: "What may /public show?" } });
});

test("nextAfterHandoff: listed next steps → continue; none / empty / missing section → idle", () => {
  expect(nextAfterHandoff({ note: NOTE_MORE, openDecisions: [] })).toEqual({ kind: "continue" });
  expect(nextAfterHandoff({ note: NOTE_DONE, openDecisions: [] })).toEqual({ kind: "idle" });
  expect(nextAfterHandoff({ note: "## Next steps\n\n- nothing\n- n/a\n—\n## Gotchas\nx", openDecisions: [] })).toEqual({ kind: "idle" });
  expect(nextAfterHandoff({ note: "## Goal\nx\n", openDecisions: [] })).toEqual({ kind: "idle" });
});

test("the handoff notice always ends with what happens next", () => {
  const cfg = { sweetSpotPct: 0.4 } as ContextPolicyCfg;
  expect(describeContextReset("handoff", 0.41, cfg, "above-sweet-spot", "settled", "continuing as #142")).toBe(
    "🔁 context handoff at 41% (above the 40% sweet spot, task done) — continuing as #142",
  );
  expect(describeContextReset("handoff", 0.41, cfg, "above-sweet-spot", "settled")).not.toContain("the next session starts from HANDOFF.md");
});

// --- Neo's note lives outside the repo -----------------------------------------------------------

function project(): string {
  const f = join(mkdtempSync(join(tmpdir(), "neo-proj-")), "waselni");
  mkdirSync(f);
  return f;
}

test("Neo's note path is under the notes dir, keyed by the folder path — never in the project", () => {
  const f = project();
  expect(neoNotePath(f)).toBe(join(NOTES, `${encodeCwd(f)}.md`));
  expect(neoNotePath(f).startsWith(f)).toBe(false);
});

test("finalizing a handoff writes Neo's note and leaves the project's own HANDOFF.md byte-identical", () => {
  const f = project();
  const own = "# HANDOFF — the 52-plan audit\n(the project's own notes)\n";
  writeFileSync(join(f, "HANDOFF.md"), own);
  writeFileSync(neoNotePath(f), NOTE_MORE);
  const r = finalizeHandoffNote(f, { occupancy: 0.41, at: 1, boundary: "settled" }, { before: undefined, fallback: () => "fallback" });
  expect(r.written).toBe(true);
  expect(readFileSync(join(f, "HANDOFF.md"), "utf8")).toBe(own);
  expect(readFileSync(neoNotePath(f), "utf8")).toContain("## Engine facts");
});

test("an idle close writes Neo's note, never the project's HANDOFF.md", () => {
  const f = project();
  writeFileSync(join(f, "HANDOFF.md"), "own");
  writeIdleStateNote({ name: "waselni", order: { folder: f, task: "x" } } as never, { now: () => 5 });
  expect(readFileSync(join(f, "HANDOFF.md"), "utf8")).toBe("own");
  expect(readFileSync(neoNotePath(f), "utf8")).toContain("# HANDOFF — waselni");
});

test("the next session gets Neo's note inline and is told to read the project's own HANDOFF.md too", () => {
  const f = project();
  writeFileSync(join(f, "HANDOFF.md"), "own");
  writeFileSync(neoNotePath(f), NOTE_MORE);
  const ledger = openLedger(":memory:");
  ledger.recordContextEvent(f, "handoff", 0.41, 1, { reason: "above-sweet-spot", boundary: "settled" });
  const pre = handoffPreamble(f, ledger, { handoffNoteMaxChars: 20_000 }, 2)!;
  expect(pre.text).toContain("Phase 5: wallet ledger");
  expect(pre.text).toContain("HANDOFF.md");
  expect(pre.text).toContain("belongs to the project");
});

test("the handoff prompt, the checkpoint steer and the governor allowance all point at Neo's note", () => {
  const f = project();
  expect(handoffPrompt(f)).toContain(neoNotePath(f));
  expect(handoffPrompt(f)).not.toContain("HANDOFF.md in the project root");
  expect(checkpointSteer(0.61, f)).toContain(neoNotePath(f));
  expect(steerAllows(f, "Write", { file_path: neoNotePath(f) })).toBe(true);
  expect(steerAllows(f, "Write", { file_path: join(f, "HANDOFF.md") })).toBe(false);
});

// --- dispatch + the todo queue ---------------------------------------------------------------------

function rig() {
  const root = mkdtempSync(join(tmpdir(), "neo-hn-"));
  const folder = join(root, "eticket-v3");
  mkdirSync(folder);
  const g = (...a: string[]) => Bun.spawnSync(["git", "-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  g("init", "-q");
  writeFileSync(join(folder, "a.txt"), "1");
  g("add", ".");
  g("commit", "-q", "-m", "first");
  const replies: string[] = [];
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const deps: DispatchDeps = {
    ledger,
    registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text) => void replies.push(text),
    askApproval: async () => "deny",
    workRoot: root,
    contextPolicy: { sweetSpotPct: 0.4, checkpointPct: 0.6, emergencyPct: 0.9, handoffNoteMaxChars: 20_000, handoffOrientationMaxSteps: 70, maxTurns: 200, maxAgeMs: 1e12, handoffTimeoutMs: 1_000, staleResumePct: 0.35, cacheTtlFallbackMs: 3_600_000, cacheTtlMinObservations: 5 },
  };
  const runs: Array<{ task: string; finish: (r: RunResult) => void }> = [];
  const start = (order: { task: string }) => {
    let finish!: (r: RunResult) => void;
    const done = new Promise<RunResult>((res) => (finish = res));
    runs.push({ task: order.task, finish });
    return { followUp: () => {}, queued: () => 0, active: () => false, closed: () => false, close: () => {}, interrupt: async () => {}, done };
  };
  // The fake handoff turn: the worker "writes" `note`, then the engine completes the handoff.
  const tails: Array<string | undefined> = [];
  let note = NOTE_MORE;
  const handoff = async (_s: unknown, _c: unknown, hd: { next?: (n: string) => string | undefined }) => void tails.push(hd.next?.(note));
  const queue = createTodoQueue({
    ledger,
    registry,
    onFailure: () => "continue",
    retryBackoffMs: () => [],
    dispatchOpts: { start: start as never, now: () => 1_000, signals: () => ({ occupancy: 0.41, turns: 5, ageMs: 0, idleMs: 0 }), handoff: handoff as never },
  });
  queue.setLauncher(() => ({ deps, replyChat: 1 }));
  return { folder, ledger, registry, deps, queue, runs, replies, tails, setNote: (n: string) => (note = n) };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const done = (summary = "Phase 4 is finished."): RunResult => ({ ok: true, sessionId: "s1", summary, costUsd: 0 });

test("a finished task handed off with next steps continues automatically as a todo at the head", async () => {
  const { queue, ledger, runs, tails } = rig();
  await queue.submit({ project: "eticket-v3", brief: "Execute Phase 4", workClass: "interactive" }, queue.launcher()!.deps, 1);
  await queue.submit({ project: "eticket-v3", brief: "later", workClass: "interactive" }, queue.launcher()!.deps, 1);
  runs[0]!.finish(done());
  await settle();
  const cont = ledger.listTodos({}).find((t) => t.brief.startsWith("Continue this task"))!;
  expect(cont).toBeDefined();
  expect(tails).toEqual([`continuing as #${cont.id}`]);
  expect(cont.brief).toContain("Execute Phase 4");
  expect(cont.brief).toContain("approved"); // the continuation itself sticks to approved work
  expect(runs[1]!.task).toContain("Continue this task"); // it ran before "later"
});

test("a finished task blocked on its own open decision parks a waiting todo, then runs it when answered", async () => {
  const { queue, ledger, registry, runs, tails, folder, deps } = rig();
  await queue.submit({ project: "eticket-v3", brief: "Execute Phase 4", workClass: "interactive" }, deps, 1);
  const t = ledger.listTodos({ statuses: ["running"] })[0]!;
  const decId = ledger.openDecision({ kind: "decision", project: "eticket-v3", folder, orderId: t.orderId, chatId: 1, question: "What may /public show?" });
  ledger.openDecision({ kind: "decision", project: "eticket-v3", folder, orderId: "someone-else", chatId: 1, question: "old, unrelated" });
  runs[0]!.finish(done());
  await settle();
  const waiting = ledger.listTodos({ statuses: ["waiting"] })[0]!;
  expect(waiting.waitingOn).toBe(decId);
  expect(tails).toEqual([`paused: waiting on decision #${decId.slice(0, 8)} — What may /public show? (continues as #${waiting.id} once answered)`]);
  expect(runs).toHaveLength(1); // nothing spins
  // visible: /todo and the console
  expect(handleCommand("/todo", 1, { registry, ledger, trust: deps.trust, todo: queue })!.text).toContain(`⏸ #${waiting.id} waiting on decision #${decId.slice(0, 8)}`);
  expect(dashboardSnapshot({ registry, ledger, chatId: 1, reposRoot: "/nonexistent" }).todos.some((x) => x.id === waiting.id && x.status === "waiting")).toBe(true);
  // answered → the same todo runs with the answer, and no operator session is seeded
  const dec = ledger.decisionById(decId)!;
  const resumed = answerDecision({ registry, ledger, parked: (d, a) => !!queue.decisionAnswered(d.id, d.question, a) }, dec, "Minimal public view", 1);
  expect(resumed).toBeUndefined();
  expect(ledger.decisionById(decId)?.status).toBe("answered");
  await settle();
  expect(ledger.todoById(waiting.id)?.status).toBe("running");
  expect(runs[1]!.task).toContain("Minimal public view");
  expect(runs[1]!.task).toContain("What may /public show?");
});

test("a finished task with nothing left says done, idle and queues nothing", async () => {
  const { queue, ledger, runs, tails, setNote } = rig();
  setNote(NOTE_DONE);
  await queue.submit({ project: "eticket-v3", brief: "Execute Phase 7", workClass: "interactive" }, queue.launcher()!.deps, 1);
  runs[0]!.finish(done());
  await settle();
  expect(tails).toEqual(["done, idle"]);
  expect(ledger.listTodos({ statuses: ["queued", "waiting", "running"] })).toHaveLength(0);
});

test("a waiting todo can be cancelled; an answer to a decision with nothing parked seeds the old resume", async () => {
  const { queue, ledger, runs, folder, deps, registry } = rig();
  await queue.submit({ project: "eticket-v3", brief: "x", workClass: "interactive" }, deps, 1);
  const t = ledger.listTodos({ statuses: ["running"] })[0]!;
  const decId = ledger.openDecision({ kind: "decision", project: "eticket-v3", folder, orderId: t.orderId, chatId: 1, question: "q?" });
  runs[0]!.finish(done());
  await settle();
  const w = ledger.listTodos({ statuses: ["waiting"] })[0]!;
  expect(queue.cancel(w.id)).toContain(`cancelled #${w.id}`);
  expect(queue.decisionAnswered(decId, "q?", "yes")).toBeUndefined();
  const other = ledger.openDecision({ kind: "decision", project: "eticket-v3", folder, chatId: 1, question: "unparked?" });
  const r = answerDecision({ registry, ledger, parked: (d, a) => !!queue.decisionAnswered(d.id, d.question, a) }, ledger.decisionById(other)!, "ok", 1);
  expect(r?.brief).toBeTruthy(); // no parked todo → the old path: resume the project's session
});

test("a dispatch outside the queue still says what happens next", async () => {
  const { deps, folder, runs } = rig();
  const tails: Array<string | undefined> = [];
  await dispatchToProject("eticket-v3", "task", deps, 1, {
    start: ((o: { task: string }) => {
      runs.push({ task: o.task, finish: () => {} });
      return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, close: () => {}, done: Promise.resolve(done()) };
    }) as never,
    root: join(folder, ".."),
    signals: () => ({ occupancy: 0.41, turns: 5, ageMs: 0, idleMs: 0 }),
    handoff: (async (_s: unknown, _c: unknown, hd: { next?: (n: string) => string | undefined }) => void tails.push(hd.next?.(NOTE_MORE))) as never,
  });
  await settle();
  expect(tails[0]).toBe("the next dispatch to this project starts from Neo's note");
  expect(existsSync(join(folder, "HANDOFF.md"))).toBe(false);
});

// --- code-review fixes ----------------------------------------------------------------------------

test("nextAfterHandoff: markdown-wrapped and 'done' lines are no work; a plan card waits on its own tap", () => {
  for (const l of ["(none)", "**None**", "_None_", "*None*", "Done.", "Task complete.", "All done — nothing remaining.", "No pending work", "No action needed", "Not applicable", "- [ ] None"]) {
    expect(nextAfterHandoff({ note: `## Next steps\n${l}\n## Gotchas\nx`, openDecisions: [] })).toEqual({ kind: "idle" });
  }
  expect(nextAfterHandoff({ note: "### 5. Next steps\n1. Phase 5\n", openDecisions: [] })).toEqual({ kind: "continue" });
  expect(nextAfterHandoff({ note: NOTE_MORE, openDecisions: [{ id: "p1", question: "Plan: phase 5", plan: true }] })).toEqual({ kind: "plan", decision: { id: "p1", question: "Plan: phase 5" } });
});

test("a run that ended on a plan card parks nothing: the plan's Execute tap queues the work", async () => {
  const { queue, ledger, runs, tails, folder, deps } = rig();
  await queue.submit({ project: "eticket-v3", brief: "write the phase 5 plan", workClass: "interactive" }, deps, 1);
  const t = ledger.listTodos({ statuses: ["running"] })[0]!;
  const decId = ledger.openDecision({ kind: "decision", project: "eticket-v3", folder, orderId: t.orderId, chatId: 1, question: "Plan: phase 5" });
  ledger.upsertPlan({ project: "eticket-v3", folder, path: "plans/p5.md", title: "P5", sha256: "s", status: "sent", stepsTotal: 0, stepsDone: 0, version: 1, decisionId: decId });
  runs[0]!.finish(done());
  await settle();
  expect(tails[0]).toContain(`waiting on plan approval #${decId.slice(0, 8)}`);
  expect(ledger.listTodos({ statuses: ["waiting", "queued"] })).toHaveLength(0);
});

test("a parked continuation carries the note itself, and the pending handoff is claimed", async () => {
  const { queue, ledger, runs, folder, deps } = rig();
  await queue.submit({ project: "eticket-v3", brief: "Execute Phase 4", workClass: "interactive" }, deps, 1);
  const t = ledger.listTodos({ statuses: ["running"] })[0]!;
  ledger.openDecision({ kind: "decision", project: "eticket-v3", folder, orderId: t.orderId, chatId: 1, question: "q?" });
  ledger.recordContextEvent(folder, "handoff", 0.41, 999, { reason: "above-sweet-spot", boundary: "settled" });
  runs[0]!.finish(done());
  await settle();
  const w = ledger.listTodos({ statuses: ["waiting"] })[0]!;
  expect(w.brief).toContain("Phase 5: wallet ledger");
  expect(ledger.pendingHandoff(folder)).toBeUndefined();
});

test("an answer that arrives while the handoff is still writing its note joins the continuation — one run, no session", async () => {
  const { queue, ledger, registry, runs, folder, deps } = rig();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tails: Array<string | undefined> = [];
  const q2 = createTodoQueue({
    ledger,
    registry,
    onFailure: () => "continue",
    retryBackoffMs: () => [],
    dispatchOpts: {
      start: ((o: { task: string }) => {
        let finish!: (r: RunResult) => void;
        const d = new Promise<RunResult>((res) => (finish = res));
        runs.push({ task: o.task, finish });
        return { followUp: () => {}, queued: () => 0, active: () => false, closed: () => false, close: () => {}, interrupt: async () => {}, done: d };
      }) as never,
      now: () => 1_000,
      signals: () => ({ occupancy: 0.41, turns: 5, ageMs: 0, idleMs: 0 }),
      handoff: (async (_s: unknown, _c: unknown, hd: { next?: (n: string) => string | undefined }) => {
        await gate;
        tails.push(hd.next?.(NOTE_DONE));
      }) as never,
    },
  });
  q2.setLauncher(() => ({ deps, replyChat: 1 }));
  void queue;
  await q2.submit({ project: "eticket-v3", brief: "Execute Phase 4", workClass: "interactive" }, deps, 1);
  const t = ledger.listTodos({ statuses: ["running"] })[0]!;
  const decId = ledger.openDecision({ kind: "decision", project: "eticket-v3", folder, orderId: t.orderId, chatId: 1, question: "What may /public show?" });
  runs[0]!.finish(done());
  await settle();
  const r = answerDecision({ registry, ledger, parked: (d, a) => !!q2.decisionAnswered(d.id, d.question, a) }, ledger.decisionById(decId)!, "Minimal public view", 1);
  expect(r).toBeUndefined(); // no operator session seeded
  release();
  await settle(60);
  const cont = ledger.listTodos({}).find((x) => x.brief.includes("Minimal public view"))!;
  expect(tails[0]).toBe(`continuing as #${cont.id} (with your answer)`);
  expect(runs.filter((x) => x.task.includes("Minimal public view"))).toHaveLength(1);
});

test("a handoff turn that could not write the file replies with the note, and the engine keeps it", async () => {
  const { runHandoff } = await import("../src/engine/context-policy");
  const f = project();
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add({ id: "h", source: "neo", folder: f, task: "t", chatId: 1, createdAt: 0 }, 0);
  const cfg = { sweetSpotPct: 0.4, checkpointPct: 0.6, emergencyPct: 0.9, handoffNoteMaxChars: 20_000, handoffOrientationMaxSteps: 70, maxTurns: 200, maxAgeMs: 1e12, handoffTimeoutMs: 1_000, staleResumePct: 0.35, cacheTtlFallbackMs: 3_600_000, cacheTtlMinObservations: 5 } as ContextPolicyCfg;
  const fakeRun = async () => ({ ok: true, sessionId: "x", summary: NOTE_MORE, costUsd: 0 });
  await runHandoff(s, cfg, { registry, ledger, run: fakeRun as never, facts: () => ({}) });
  expect(readFileSync(neoNotePath(f), "utf8")).toContain("Phase 5: wallet ledger");
});
