// Task 1.4 (spec §4.2, §4.3, §11.2, §11.3): the cause travels with each turn — pipeline, registry,
// session-runner turn end, and the reload snapshot.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleMessage } from "../src/engine/pipeline";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { createTrace } from "../src/engine/trace";
import { drainAndPersist, restoreSessions } from "../src/engine/reload";
import { loadConfig } from "../src/config";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";
import type { Order } from "../src/types";

const scratch = () => mkdtempSync(join(tmpdir(), "neo-trace-pipe-"));

/** A live fake session that stays running until finish(); the test drives its handlers. */
function fakeStart() {
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((res) => (resolveDone = res));
  let handlers!: RunHandlers;
  const followUps: string[] = [];
  const start = (_o: Order, h: RunHandlers): SessionRun => {
    handlers = h;
    return { followUp: (t) => void followUps.push(t), interrupt: async () => {}, queued: () => 0, active: () => true, close: () => {}, closed: () => false, done };
  };
  return { start, h: () => handlers, finish: (r: RunResult) => resolveDone(r), followUps };
}

function harness(opts: { showRefs?: "auto" | "off" } = {}) {
  const sent: string[] = [];
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const trace = createTrace({ ledger, registry });
  const cfg = loadConfig(scratch());
  cfg.trustNewProjects = false;
  if (opts.showRefs) cfg.trace = { showRefs: opts.showRefs };
  const f = fakeStart();
  const deps = {
    cfg,
    ledger,
    registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c: number, t: string) => void sent.push(t),
    askApproval: async () => "allow" as const,
    start: f.start,
    trace,
  };
  return { sent, ledger, registry, trace, deps, f };
}

const inbound = (h: ReturnType<typeof harness>, text: string) => h.trace.inbound({ chatId: 7, text, surface: "telegram" });
const tick = () => new Promise((r) => setTimeout(r, 1));

test("handleMessage stamps the order and every reply line with the inbound cause", async () => {
  const h = harness();
  const dir = scratch();
  const text = `/open ${dir} build x`;
  const cause = inbound(h, text);
  await handleMessage(text, 7, h.deps, "neo", cause);
  h.f.h().onMessage("working on it");
  h.f.h().onMessage("🔧 Bash: ls", "tool");

  const order = h.ledger.listRecent()[0]!;
  expect(h.ledger.threadArtifacts(cause.threadId, 10).orders.map((o) => o.id)).toEqual([order.id]);
  // The operator line was written once (by trace.inbound), never again by the pipeline.
  const convo = h.ledger.conversation(7);
  expect(convo.filter((m) => m.role === "user").length).toBe(1);
  // Every assistant line in the chat is filed under the cause's thread.
  const inThread = h.ledger.messagesInThread(cause.threadId, { limit: 100 }).reverse(); // oldest first
  const assistant = inThread.filter((m) => m.role === "assistant");
  expect(assistant.length).toBe(convo.filter((m) => m.role === "assistant").length);
  expect(assistant.every((m) => m.causeId === cause.msgId)).toBe(true);
  expect(assistant.map((m) => m.kind)).toEqual(["ack", "text", "progress"]);
  // The session is in its turn: the thread is open.
  expect(h.ledger.threadById(cause.threadId)?.state).toBe("open");
});

test("two follow-ups queued during one turn: output goes to the later one, both are answered at turn end", async () => {
  const h = harness();
  const dir = scratch();
  const first = inbound(h, `/open ${dir} go`);
  await handleMessage(`/open ${dir} go`, 7, h.deps, "neo", first);
  const id = h.registry.list()[0]!.id;
  h.registry.setFocus(7, id, "pinned");

  const a = inbound(h, "and a");
  await handleMessage("and a", 7, h.deps, "neo", a);
  const b = inbound(h, "and b");
  await handleMessage("and b", 7, h.deps, "neo", b);
  expect(h.f.followUps).toEqual(["and a", "and b"]);
  expect(h.ledger.threadById(a.threadId)?.state).toBe("open");

  h.f.h().onMessage("x");
  const x = h.ledger.messagesInThread(b.threadId, { limit: 50 }).find((m) => m.content === "x");
  expect(x?.causeId).toBe(b.msgId);

  h.f.h().onTurnEnd?.();
  expect(h.registry.causeOf(id)).toBeUndefined();
  for (const c of [first, a, b]) expect(h.ledger.threadById(c.threadId)?.state).toBe("done");
  // The ack for each follow-up is filed under its own message.
  const ackA = h.ledger.messagesInThread(a.threadId, { limit: 50 }).find((m) => m.kind === "ack");
  expect(ackA?.content).toContain("queued for");
});

test("the first reply of a turn carries the ref, the next ones do not", async () => {
  const h = harness();
  const dir = scratch();
  const cause = inbound(h, `/open ${dir} go`);
  await handleMessage(`/open ${dir} go`, 7, h.deps, "neo", cause);
  const ref = h.trace.ref(cause.msgId);
  h.f.h().onMessage("one");
  h.f.h().onMessage("two");
  h.f.h().onMessage("🔧 Bash: ls", "tool");
  expect(h.sent[0]).toEndWith(` · \`${ref}\``); // the "opening…" ack
  expect(h.sent.slice(1)).toEqual([`one · \`${ref}\``, "two", "🔧 Bash: ls"]);
  // The ledger keeps the line itself; the ref is derived from the ids.
  expect(h.ledger.conversation(7).some((m) => m.content === "one")).toBe(true);

  // A new turn: its first reply carries the new message's ref.
  h.f.h().onTurnEnd?.();
  h.registry.setFocus(7, h.registry.list()[0]!.id, "pinned");
  const next = inbound(h, "more");
  await handleMessage("more", 7, h.deps, "neo", next);
  h.f.h().onMessage("three");
  h.f.h().onMessage("four");
  expect(h.sent.slice(-2)).toEqual([`three · \`${h.trace.ref(next.msgId)}\``, "four"]);
});

test("the run's final line is a result under the last answered cause, with the thread ref", async () => {
  const h = harness();
  const dir = scratch();
  const cause = inbound(h, `/open ${dir} go`);
  const run = await handleMessage(`/open ${dir} go`, 7, h.deps, "neo", cause);
  h.f.h().onTurnEnd?.();
  h.f.finish({ ok: true, sessionId: "s1", summary: "all done", costUsd: 0 });
  await run!.done;
  await tick();
  const last = h.ledger.messagesInThread(cause.threadId, { limit: 50 })[0]!;
  expect(last).toMatchObject({ content: "all done", kind: "result", causeId: cause.msgId });
  expect(h.sent.at(-1)).toBe(`all done · \`${h.trace.ref(cause.threadId)}\``);
});

test("trace.showRefs off: no line carries a ref", async () => {
  const h = harness({ showRefs: "off" });
  const dir = scratch();
  const cause = inbound(h, `/open ${dir} go`);
  await handleMessage(`/open ${dir} go`, 7, h.deps, "neo", cause);
  h.f.h().onMessage("one");
  expect(h.sent.some((s) => s.includes(" · `m"))).toBe(false);
});

test("an approval prompt and its verdict are filed under the session's cause", async () => {
  const h = harness();
  const dir = scratch();
  const cause = inbound(h, `/open ${dir} go`);
  await handleMessage(`/open ${dir} go`, 7, h.deps, "neo", cause);
  await h.f.h().onEscalation("risky shell command: rm -rf build");
  const rows = h.ledger.messagesInThread(cause.threadId, { limit: 50 });
  const ask = rows.find((m) => m.kind === "approval");
  expect(ask?.content).toContain("rm -rf build");
  expect(rows.some((m) => m.role === "user" && m.content === "approval: allow" && m.causeId === ask?.id)).toBe(true);
});

test("an open-session snapshot keeps the cause across a reload", async () => {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const trace = createTrace({ ledger, registry });
  const cause = trace.inbound({ chatId: 7, text: "work on beta", surface: "telegram" });
  ledger.saveOpenSessions([
    { id: "s1", name: "beta", folder: "/home/beta", chatId: 7, sdkSessionId: "sdk", task: "t", source: "neo", createdAt: 1, cause },
    { id: "s2", name: "gamma", folder: "/home/gamma", chatId: 7, sdkSessionId: "sdk2", task: "t", source: "neo", createdAt: 2 },
  ]);
  const rows = ledger.takeOpenSessions();
  expect(rows[0]!.cause).toEqual(cause);
  expect(rows[1]!.cause).toBeUndefined();

  ledger.saveOpenSessions(rows);
  restoreSessions(registry, ledger);
  // §11.3: restored without a live cause; the stored one files its first output.
  expect(registry.causeOf("s1")).toBeUndefined();
  expect(registry.lastCauseOf("s1")).toEqual(cause);
  expect(registry.lastCauseOf("s2")).toBeUndefined();
});

test("drainAndPersist snapshots the session's last cause even after its turn ended", async () => {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const s = registry.add({ id: "s1", source: "neo", folder: "/home/beta", task: "t", chatId: 7, createdAt: 1 });
  registry.setStatus(s.id, "idle");
  registry.setCause(s.id, { msgId: 5, threadId: 5 });
  registry.endTurn(s.id); // the wrap-up turn ended before the snapshot
  await drainAndPersist({ registry, ledger, drainMs: 0 });
  expect(ledger.takeOpenSessions()[0]!.cause).toEqual({ msgId: 5, threadId: 5 });
});

test("without deps.trace the pipeline records exactly as before", async () => {
  const h = harness();
  const deps = { ...h.deps, trace: undefined };
  const dir = scratch();
  await handleMessage(`/open ${dir} go`, 7, deps);
  h.f.h().onMessage("one");
  const convo = h.ledger.conversation(7);
  expect(convo[0]).toMatchObject({ role: "user", content: `/open ${dir} go` });
  expect(h.sent.some((s) => s.includes(" · `m"))).toBe(false);
  expect(convo.some((m) => m.content === "one")).toBe(true);
});

test("inbound: a failing thread insert leaves no orphan message; a failing refresh never loses the line", () => {
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const trace = createTrace({ ledger, registry });
  const insertThread = ledger.insertThread;
  ledger.insertThread = () => {
    throw new Error("disk full");
  };
  expect(() => trace.inbound({ chatId: 7, text: "hello", surface: "telegram" })).toThrow("disk full");
  expect(ledger.conversation(7)).toEqual([]);
  expect(() => trace.root({ origin: "loop", title: "nightly" })).toThrow("disk full");
  expect(ledger.conversation(0)).toEqual([]);
  ledger.insertThread = insertThread;

  ledger.threadFacts = () => {
    throw new Error("locked");
  };
  const c = trace.inbound({ chatId: 7, text: "hello", surface: "telegram" });
  expect(ledger.messageById(c.msgId)?.threadId).toBe(c.threadId);
  expect(ledger.threadById(c.threadId)).toBeDefined();
});

// --- Fix round 1 (review of Task 1.4) ---

test("a session removed mid-turn (/kill, idle sweep): its causes are answered and the final line goes to the latest one", async () => {
  const h = harness();
  const dir = scratch();
  const a = inbound(h, `/open ${dir} go`);
  const run = await handleMessage(`/open ${dir} go`, 7, h.deps, "neo", a);
  const id = h.registry.list()[0]!.id;
  h.registry.setFocus(7, id, "pinned");
  const b = inbound(h, "and b");
  await handleMessage("and b", 7, h.deps, "neo", b);
  expect(h.ledger.threadById(b.threadId)?.state).toBe("open");

  h.registry.remove(id); // what /kill and the idle sweep do, before the run has ended
  h.f.finish({ ok: false, sessionId: "s1", summary: "interrupted", costUsd: 0 });
  await run!.done;
  await tick();
  // Nothing is stuck "open": A's order ended in an error (a killed run), so its thread failed.
  expect(h.ledger.threadById(a.threadId)?.state).toBe("failed");
  expect(h.ledger.threadById(b.threadId)?.state).toBe("done");
  const last = h.ledger.messagesInThread(b.threadId, { limit: 50 })[0]!;
  expect(last).toMatchObject({ content: "interrupted", causeId: b.msgId });
});

test("§11.3: a restored session has no live cause; a resume with no new message files its first output under the stored cause", async () => {
  const h = harness();
  const dir = scratch();
  const stored = inbound(h, "work on beta");
  h.ledger.saveOpenSessions([{ id: "s1", name: "beta", folder: dir, chatId: 7, sdkSessionId: "", task: "t", source: "neo", createdAt: 1, cause: stored }]);
  restoreSessions(h.registry, h.ledger);
  expect(h.registry.causeOf("s1")).toBeUndefined(); // not active work
  expect(h.registry.lastCauseOf("s1")).toEqual(stored);
  h.trace.refreshThread(stored.threadId);
  expect(h.ledger.threadById(stored.threadId)?.state).toBe("done");

  h.registry.setFocus(7, "s1", "pinned");
  await handleMessage("carry on", 7, h.deps); // no cause: no new operator message reaches the trace
  h.f.h().onMessage("first output");
  const row = h.ledger.messagesInThread(stored.threadId, { limit: 50 }).find((m) => m.content === "first output");
  expect(row?.causeId).toBe(stored.msgId);
  expect(h.ledger.threadById(stored.threadId)?.state).toBe("done"); // not stuck "open"
  h.f.h().onTurnEnd?.();
  expect(h.ledger.threadById(stored.threadId)?.state).toBe("done");
});

test("a turn answers only the inputs it consumed: Codex A then queued B", async () => {
  const h = harness();
  const dir = scratch();
  const a = inbound(h, `/open ${dir} go`);
  await handleMessage(`/open ${dir} go`, 7, h.deps, "neo", a);
  const id = h.registry.list()[0]!.id;
  h.registry.setFocus(7, id, "pinned");
  h.f.h().onTurnStart?.(1); // the Codex loop took A

  const b = inbound(h, "and b");
  await handleMessage("and b", 7, h.deps, "neo", b); // queued behind A's turn
  h.f.h().onMessage("a-out");
  const aOut = h.ledger.messagesInThread(a.threadId, { limit: 50 }).find((m) => m.content === "a-out");
  expect(aOut?.causeId).toBe(a.msgId);

  h.f.h().onTurnEnd?.();
  expect(h.ledger.threadById(a.threadId)?.state).toBe("done");
  expect(h.ledger.threadById(b.threadId)?.state).toBe("open"); // B has not run yet

  h.f.h().onTurnStart?.(1); // B's own turn
  h.f.h().onMessage("b-out");
  expect(h.ledger.messagesInThread(b.threadId, { limit: 50 }).find((m) => m.content === "b-out")?.causeId).toBe(b.msgId);
  expect(h.ledger.threadById(b.threadId)?.state).toBe("open");
  h.f.h().onTurnEnd?.();
  expect(h.ledger.threadById(b.threadId)?.state).toBe("done");
});

test("a resume that throws before the run starts leaves no cause delivered (thread not stuck open)", async () => {
  const h = harness();
  const dir = scratch();
  const first = inbound(h, `/open ${dir} go`);
  const run = await handleMessage(`/open ${dir} go`, 7, h.deps, "neo", first);
  h.f.finish({ ok: true, sessionId: "s1", summary: "ok", costUsd: 0 });
  await run!.done;
  await tick();
  const id = h.registry.list()[0]!.id;
  h.registry.setFocus(7, id, "pinned");
  const deps = { ...h.deps, reply: (_c: number, t: string) => { if (t.startsWith("↩︎ resuming")) throw new Error("channel down"); h.sent.push(t); } };
  const c = inbound(h, "again");
  await expect(handleMessage("again", 7, deps, "neo", c)).rejects.toThrow("channel down");
  expect(h.registry.causeOf(id)).toBeUndefined();
  expect(h.ledger.threadById(c.threadId)?.state).toBe("done");
});

test("the approval verdict row uses the injected clock and is the thread's newest line", async () => {
  const h = harness();
  const dir = scratch();
  const cause = inbound(h, `/open ${dir} go`);
  await handleMessage(`/open ${dir} go`, 7, { ...h.deps, now: () => 4242 }, "neo", cause);
  await h.f.h().onEscalation("risky shell command: rm -rf build");
  const newest = h.ledger.messagesInThread(cause.threadId, { limit: 1 })[0]!;
  expect(newest).toMatchObject({ role: "user", content: "approval: allow", at: 4242 });
  expect(h.ledger.threadById(cause.threadId)?.lastMsgId).toBe(newest.id);
});

test("an operator message that opens a project: its thread reads that project, and /trace shows it", async () => {
  const h = harness();
  const dir = scratch();
  const cause = inbound(h, `/open ${dir} build x`);
  await handleMessage(`/open ${dir} build x`, 7, h.deps, "neo", cause);
  h.f.h().onMessage("working on it");
  const name = h.registry.findByFolder(dir)!.name;
  expect(h.ledger.threadById(cause.threadId)).toMatchObject({ project: name, folder: dir });
  const { renderTrace } = await import("../src/engine/trace");
  expect(renderTrace(h.trace.tree(cause.msgId), h.trace.ref).split("\n")[1]).toContain(name);
});
