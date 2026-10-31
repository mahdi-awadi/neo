// ADR-0072: a todo has a size — the ledger part (spec §11, AC 5).
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import type { SizeUp } from "../src/engine/order-size";

const base = { project: "p", folder: "/p", brief: "fix the picker", workClass: "interactive" as const, createdBy: "company" as const };

test("a todo with no size is big, set by nobody", () => {
  const l = openLedger(":memory:");
  const t = l.addTodo(base);
  expect(t.size).toBe("big");
  expect(t.sizeBy).toBeUndefined();
  expect(t.sizeUp).toBeUndefined();
});

test("addTodo stores the size and who set it", () => {
  const l = openLedger(":memory:");
  const t = l.addTodo({ ...base, size: "quick", sizeBy: "operator" });
  expect(l.todoById(t.id)).toMatchObject({ size: "quick", sizeBy: "operator" });
  expect(l.listTodos({ folder: "/p" })[0]).toMatchObject({ size: "quick", sizeBy: "operator" });
});

test("updateTodo patches the size and the size up (JSON round trip); null clears the size up", () => {
  const l = openLedger(":memory:");
  const t = l.addTodo({ ...base, size: "quick", sizeBy: "company" });
  const sizeUp: SizeUp = { from: "quick", to: "big", rule: "auth", path: "services/identity-service/auth/token.go", at: 1234 };
  l.updateTodo(t.id, { size: "big", sizeUp });
  expect(l.todoById(t.id)).toMatchObject({ size: "big", sizeBy: "company", sizeUp });
  const late: SizeUp = { from: "quick", to: "standard", rule: "files", value: 6, max: 5, late: true, at: 99 };
  l.updateTodo(t.id, { sizeUp: late });
  expect(l.todoById(t.id)!.sizeUp).toEqual(late);
  l.updateTodo(t.id, { sizeUp: null });
  expect(l.todoById(t.id)!.sizeUp).toBeUndefined();
});

test("a bad stored size reads as big; bad size_up JSON reads as none, never a throw", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-sizes-")), "ledger.db");
  const l = openLedger(path);
  const t = l.addTodo({ ...base, size: "quick" });
  const db = new Database(path); // a second connection writes what an old or broken build left
  db.run(`UPDATE project_todos SET size = 'huge', size_by = 'someone', size_up = '{not json' WHERE id = ?`, [t.id]);
  const row = l.todoById(t.id)!;
  expect(row.size).toBe("big");
  expect(row.sizeBy).toBeUndefined();
  expect(row.sizeUp).toBeUndefined();
  // Well-formed JSON that is not a size up reads as none too.
  db.run(`UPDATE project_todos SET size_up = '{"from":"tiny","to":"big","rule":"x","at":1}' WHERE id = ?`, [t.id]);
  expect(l.todoById(t.id)!.sizeUp).toBeUndefined();
});

// ── The queue part (ADR-0072 spec §2, §5.4, §8; AC 3, 13–16, 20) ─────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { briefForSize, briefWithProjectDocs, type DispatchDeps } from "../src/engine/dispatch";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";
import { createTodoQueue } from "../src/engine/todo-queue";
import { continuationBrief, neoNotePath } from "../src/engine/context-policy";
import { retryBrief } from "../src/engine/todo-retry";
import { listOpen } from "../src/engine/attention";
import { DEFAULT_LANES_CFG } from "../src/engine/lanes";
import { CUSTOMER_CHAT } from "../src/engine/chats";
import type { OrderSize } from "../src/engine/order-size";

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const done = (summary = "all green"): RunResult => ({ ok: true, sessionId: "s1", summary, costUsd: 0 });

/** A queue over a root with `eticket-v3` (a git repo when `git`); each run's handlers are kept. */
function queueSetup(o: { git?: boolean; deps?: Partial<DispatchDeps>; uncommitted?: (f: string) => string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-tsz-"));
  const folder = join(root, "eticket-v3");
  mkdirSync(folder);
  if (o.git) {
    const g = (...a: string[]) => spawnSync("git", ["-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "dev");
    writeFileSync(join(folder, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "init");
  }
  const replies: string[] = [];
  const notes: string[] = [];
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const lanes = { ...DEFAULT_LANES_CFG, worktreeRoot: mkdtempSync(join(tmpdir(), "neo-tsz-wt-")) };
  const deps: DispatchDeps = {
    ledger,
    registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text) => void replies.push(text),
    askApproval: async () => "deny",
    dispatcher: { deliver: (text) => (notes.push(text), true) },
    workRoot: root,
    lanes,
    ...o.deps,
  };
  const runs: Array<{ task: string; folder: string; h: RunHandlers; finish: (r: RunResult) => void }> = [];
  const start = (order: { task: string; folder: string }, h: RunHandlers) => {
    let finish!: (r: RunResult) => void;
    const p = new Promise<RunResult>((res) => (finish = res));
    runs.push({ task: order.task, folder: order.folder, h, finish });
    return { followUp: () => {}, queued: () => 0, active: () => true, closed: () => false, close: () => {}, interrupt: async () => {}, done: p };
  };
  const queue = createTodoQueue({ ledger, registry, onFailure: () => "continue", dispatchOpts: { start: start as never, now: () => 1_000 }, lanes: () => lanes, ...(o.uncommitted ? { uncommitted: o.uncommitted } : {}) });
  queue.setLauncher(() => ({ deps, replyChat: 1 }));
  type Extra = { size?: OrderSize; operatorSize?: OrderSize; lane?: "side"; kind?: "ops" | "code" | "test" | "read-only"; team?: "frontend-backend" };
  const submit = (brief: string, x: Extra = {}, chat = 1) => queue.submit({ project: "eticket-v3", brief, workClass: "interactive", ...x }, deps, chat);
  return { root, folder, replies, notes, ledger, registry, deps, queue, runs, submit };
}

/** One tool call through the run's hook, as the runner does it. */
function toolCall(h: RunHandlers, id: string, tool: string, input: Record<string, unknown>): string | undefined {
  const denied = h.contextSteer?.(tool, input);
  if (denied) return denied;
  h.onToolUse?.(id, tool, input);
  h.onToolResult?.(id, false);
  return undefined;
}

test("submit stores the size and who set it, records todo_size_set, and the reply names both", async () => {
  const s = queueSetup();
  const a = await s.submit("fix the picker", { size: "quick" });
  expect(a).toContain("— size quick (yours)");
  expect(s.ledger.todoById(1)).toMatchObject({ size: "quick", sizeBy: "company" });
  expect(s.ledger.listEvents({ kind: "todo_size_set" })[0]!.data).toMatchObject({ id: 1, size: "quick", by: "company", chosen: "quick" });
  const b = await s.submit("fix the label", { size: "big", operatorSize: "quick" });
  expect(b).toContain("— size quick (the operator's /quick)");
  expect(s.ledger.todoById(2)).toMatchObject({ size: "quick", sizeBy: "operator" });
  const c = await s.submit("add the wallet");
  expect(c).toContain("— size big (default: no size was given)");
  expect(s.ledger.todoById(3)).toMatchObject({ size: "big", sizeBy: "engine" });
  const d = await s.submit("fix the date", { operatorSize: "big", size: "quick" });
  expect(d).toContain("— size big (the operator's /full)");
});

test("forced big: a Codex worker, a team order and a customer reply chat — the reply says why", async () => {
  const codex = queueSetup({ deps: { providers: { ownWork: "codex", customerWork: "gemini" } as never } });
  expect(await codex.submit("fix it", { size: "quick" })).toContain("— size big (the worker SDK is Codex: a smaller size needs the governor hook)");
  expect(codex.ledger.todoById(1)).toMatchObject({ size: "big", sizeBy: "engine" });
  const team = queueSetup();
  expect(await team.submit("build it", { size: "quick", team: "frontend-backend" })).toContain("— size big (a team order is always big)");
  const customer = queueSetup();
  expect(await customer.submit("fix it", { size: "quick" }, CUSTOMER_CHAT)).toContain("— size big (a customer-driven run is always big)");
  expect(customer.ledger.listEvents({ kind: "todo_size_set" })[0]!.data).toMatchObject({ size: "big", by: "engine", forced: "customer" });
});

test("launch passes the size: a quick todo runs with the quick preamble and a [quick] start line", async () => {
  const s = queueSetup();
  await s.submit("fix the picker", { size: "quick" });
  await settle();
  expect(s.runs[0]!.task).toBe(briefForSize("quick", "fix the picker"));
  expect(s.replies).toContain("→ dispatching to eticket-v3 [quick]: fix the picker");
});

test("an unsized side brief gets its kind's size; a big side brief runs in the main lane and the reply says why", async () => {
  const s = queueSetup();
  await s.submit("build", { size: "big" });
  await settle();
  const side = await s.submit("check docker", { lane: "side", kind: "ops" });
  expect(side).toContain("— size quick (the default for a ops side brief)");
  expect(s.ledger.todoById(2)).toMatchObject({ lane: "side", size: "quick", sizeBy: "engine" });
  const big = await s.submit("migrate the db", { lane: "side", kind: "ops", size: "big" });
  expect(s.ledger.todoById(3)).toMatchObject({ lane: "main", size: "big", status: "queued" });
  expect(big).toContain("not as a side lane: a big order runs in the main lane");
});

test("onSizeUp updates the row; the dispatcher's note names the move; the lines carry the tag", async () => {
  const s = queueSetup();
  await s.submit("fix the picker", { size: "quick" });
  await s.submit("add a filter", { size: "standard" });
  await settle();
  expect(s.replies).toContain("→ queued #2 [standard] for eticket-v3 (position 1): add a filter");
  const denied = toolCall(s.runs[0]!.h, "t1", "Write", { file_path: join(s.folder, "src/auth/token.ts"), content: "x\n" });
  expect(denied).toStartWith("STOP — Neo moved this order up from QUICK to BIG");
  expect(s.ledger.todoById(1)).toMatchObject({ size: "big", sizeUp: expect.objectContaining({ from: "quick", to: "big", rule: "auth" }) });
  expect(s.queue.list("eticket-v3")).toContain("▶ #1 [quick→big] running 0m — fix the picker");
  expect(s.queue.list("eticket-v3")).toContain("1. #2 [standard] add a filter");
  // The run ends: the dispatcher's result says what moved in this run.
  s.runs[0]!.finish(done("stopped"));
  await settle(80);
  const reports = s.ledger.pendingDispatcherReports().map((r) => r.text).join("\n") + s.notes.join("\n");
  expect(reports).toContain("[size] #1 moved up quick → big: it touches auth: src/auth/token.ts");
});

test("TodoEnd.size.requeue (main lane): the same row is queued at position 1, as big, attempts unchanged, no dirty item", async () => {
  const s = queueSetup({ uncommitted: () => ["src/auth/token.ts"] });
  await s.submit("fix the picker", { size: "quick" });
  await s.submit("later work", { size: "quick" });
  await settle();
  toolCall(s.runs[0]!.h, "t1", "Write", { file_path: join(s.folder, "src/auth/token.ts"), content: "x\n" });
  s.queue.pause("eticket-v3");
  s.runs[0]!.finish(done("stopped for a plan"));
  await settle(80);
  const t = s.ledger.todoById(1)!;
  expect(t).toMatchObject({ status: "queued", size: "big", attempts: 0 });
  expect(t.result).toBe("Neo moved this order up from quick to big (it touches auth: src/auth/token.ts); it runs again with the full flow: plan first.");
  expect(s.ledger.listTodos({ statuses: ["queued"], lane: "main" }).map((x) => x.id)).toEqual([1, 2]);
  expect(s.ledger.listEvents({ kind: "todo_size_requeued" })[0]!.data).toMatchObject({ id: 1, from: "quick", to: "big" });
  expect(listOpen(s.ledger, { now: 2_000 }).filter((i) => i.kind === "dirty")).toHaveLength(0);
  expect(s.replies.some((r) => r.startsWith("eticket-v3: #1 moved up quick → big"))).toBe(true);
  // Resumed: it runs again with the big preamble, and its brief carries the size-up result.
  s.queue.resume("eticket-v3");
  await settle(80);
  expect(s.runs[1]!.task).toBe(briefWithProjectDocs(retryBrief(s.ledger.todoById(1)!, 3)));
  expect(s.runs[1]!.task).toContain("Neo moved this order up from quick to big");
});

test("a side lane moved to big: at its end it joins the main queue at the end, as big; a code lane's branch is named", async () => {
  const s = queueSetup({ git: true });
  await s.submit("build", { size: "big" });
  await s.submit("next main work", { size: "big" });
  await settle();
  await s.submit("fix the typo", { lane: "side", kind: "code" });
  await settle(60);
  const side = s.ledger.listTodos({ lane: "side" })[0]!;
  const run = s.runs[1]!;
  expect(toolCall(run.h, "t1", "Write", { file_path: join(run.folder, "src/auth/token.ts"), content: "x\n" })).toStartWith("STOP — Neo moved this side-lane order up");
  writeFileSync(join(run.folder, "a.txt"), "b\n");
  spawnSync("git", ["-C", run.folder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "half"]);
  run.finish(done("stopped"));
  await settle(150);
  const t = s.ledger.todoById(side.id)!;
  expect(t).toMatchObject({ status: "queued", lane: "main", size: "big" });
  expect(t.laneKind).toBeUndefined();
  expect(s.ledger.listTodos({ statuses: ["queued"], lane: "main" }).map((x) => x.id)).toEqual([2, side.id]);
  expect(s.ledger.listTodos({ statuses: ["queued"] }).some((x) => x.brief.includes("merge"))).toBe(false); // no merge of half work
  expect(s.replies.some((r) => r.includes(`side #${side.id}`) && r.includes("joins the main queue as big") && r.includes(`side/${side.id}`))).toBe(true);
  expect(t.result).toContain(`side/${side.id}`);
});

test("a checkpoint continuation of a quick todo is standard (rule handoff); a big one keeps its size", async () => {
  for (const size of ["quick", "big"] as const) {
    const root = mkdtempSync(join(tmpdir(), "neo-tsz-cp-"));
    const folder = join(root, "eticket-v3");
    mkdirSync(folder);
    const g = (...a: string[]) => Bun.spawnSync(["git", "-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
    g("init", "-q");
    writeFileSync(join(folder, "a.txt"), "1");
    g("add", ".");
    g("commit", "-q", "-m", "first");
    const ledger = openLedger(":memory:");
    ledger.recordModelWindow("claude-opus-5-5", 1_000_000);
    const registry = createRegistry();
    const deps: DispatchDeps = {
      ledger, registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"),
      reply: () => {}, askApproval: async () => "deny", workRoot: root,
      contextPolicy: { sweetSpotPct: 0.4, checkpointPct: 0.6, emergencyPct: 0.9, handoffNoteMaxChars: 20_000, handoffOrientationMaxSteps: 70, maxTurns: 200, maxAgeMs: 1e12, handoffTimeoutMs: 1_000, staleResumePct: 0.35, cacheTtlFallbackMs: 3_600_000, cacheTtlMinObservations: 5 },
    };
    const runs: Array<{ finish: (r: RunResult) => void }> = [];
    const start = (_o: unknown, h: RunHandlers) => {
      let finish!: (r: RunResult) => void;
      const p = new Promise<RunResult>((res) => (finish = res));
      runs.push({ finish });
      if (runs.length === 1) {
        h.onUsage?.("claude-opus-5-5", { input_tokens: 700_000 });
        h.onToolUse?.("c1", "Bash", { command: "git commit -m 'phase 2'" });
        h.onToolResult?.("c1", false);
      }
      return { followUp: () => {}, queued: () => 0, active: () => false, closed: () => false, close: () => {}, interrupt: async () => {}, done: p };
    };
    const queue = createTodoQueue({ ledger, registry, onFailure: () => "continue", dispatchOpts: { start: start as never, now: () => 1_000, signals: () => ({ occupancy: 0.1, turns: 1, ageMs: 0, idleMs: 0 }) } });
    queue.setLauncher(() => ({ deps, replyChat: 1 }));
    await queue.submit({ project: "eticket-v3", brief: "build all phases", workClass: "interactive", size }, deps, 1);
    await settle();
    writeFileSync(neoNotePath(folder), "## Goal\nall phases\n## Next steps\n1. phase 3\n");
    runs[0]!.finish(done("note written"));
    await settle(80);
    const cont = ledger.listTodos({ folder }).find((t) => t.brief === continuationBrief("build all phases"))!;
    if (size === "quick") {
      expect(cont).toMatchObject({ size: "standard", sizeBy: "company", sizeUp: expect.objectContaining({ from: "quick", to: "standard", rule: "handoff" }) });
    } else {
      expect(cont).toMatchObject({ size: "big" });
      expect(cont.sizeUp).toBeUndefined();
    }
  }
});

test("a side continuation (an answered side question) keeps a quick size", async () => {
  const s = queueSetup();
  await s.submit("build", { size: "big" });
  await settle();
  await s.submit("create a dev user", { lane: "side", kind: "ops" });
  await settle();
  const side = s.ledger.listTodos({ lane: "side" })[0]!;
  s.ledger.openDecision({ kind: "decision", question: "Which email?", folder: side.folder, orderId: side.orderId! }, 1);
  s.runs[1]!.finish(done("asked the operator"));
  await settle(60);
  const parked = s.ledger.listTodos({ lane: "side", statuses: ["waiting"] })[0]!;
  expect(parked).toMatchObject({ size: "quick" });
  expect(parked.sizeUp).toBeUndefined();
});

test("retry keeps the size; failed, waiting and side lines carry the tag", async () => {
  const s = queueSetup();
  await s.submit("fix the picker", { size: "quick" });
  await settle();
  s.runs[0]!.finish({ ok: false, sessionId: "", summary: "boom", costUsd: 0 });
  await settle(60);
  expect(s.ledger.todoById(1)).toMatchObject({ status: "failed", size: "quick" });
  expect(s.queue.list()).toContain("✗ #1 [quick] failed — fix the picker (/todo retry 1)");
  s.queue.retry(1);
  await settle(60);
  expect(s.ledger.todoById(1)).toMatchObject({ size: "quick" });
  expect(s.runs[1]!.task).toStartWith("QUICK order");
});

test("the transition line names the next todo with its tag", async () => {
  const s = queueSetup();
  await s.submit("fix the picker", { size: "quick" });
  await s.submit("add a filter", { size: "standard" });
  await settle();
  s.runs[0]!.finish(done());
  await settle(80);
  expect(s.replies).toContain("eticket-v3: done #1, starting #2 [standard] 'add a filter'");
});

test("(b) a quick todo delivered into a live session is recorded big, by Neo, and the reply says why", async () => {
  const s = queueSetup();
  const live = s.registry.add({ id: "d1", source: "neo", folder: s.folder, task: "x", chatId: -2, createdAt: 0 }, 0);
  s.registry.setStatus(live.id, "running");
  const followUps: string[] = [];
  s.registry.attachControl(live.id, { followUp: (t: string) => void followUps.push(t), queued: () => 0, active: () => false, interrupt: async () => {} });
  const out = await s.submit("fix the picker", { size: "quick" });
  expect(followUps).toEqual([briefWithProjectDocs("fix the picker")]);
  expect(s.ledger.todoById(1)).toMatchObject({ status: "done", size: "big", sizeBy: "engine" });
  expect(s.ledger.listEvents({ kind: "todo_size_forced" })[0]!.data).toMatchObject({ id: 1, from: "quick", to: "big" });
  expect(out).toContain("— size big (delivered into a live session: no size guard there)");
});

// ADR-0072 (spec §9, AC 22): engine-made todos get their size by rule.
test("an engine size is stored by engine; a code lane's merge todo is big, by engine", async () => {
  const s = queueSetup({ git: true });
  await s.queue.submit({ project: "eticket-v3", brief: "commit the left work", workClass: "interactive", engineSize: "quick" }, s.deps, 1);
  expect(s.ledger.todoById(1)).toMatchObject({ size: "quick", sizeBy: "engine" });
  await settle();
  await s.submit("fix the typo in a.txt", { lane: "side", kind: "code" });
  await settle(60);
  const side = s.ledger.listTodos({ lane: "side" })[0]!;
  const wt = s.runs[1]!.folder;
  writeFileSync(join(wt, "a.txt"), "b\n");
  spawnSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "fix typo"]);
  s.runs[1]!.finish(done());
  await settle(150);
  const merge = s.ledger.listTodos({ lane: "main", statuses: ["queued"] }).find((x) => x.brief.includes(`side/${side.id}`));
  expect(merge).toMatchObject({ size: "big", sizeBy: "engine" });
});
