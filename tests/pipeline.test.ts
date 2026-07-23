import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { handleMessage } from "../src/engine/pipeline";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter, type Meter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { encodeCwd, transcriptLineCount, firstAssistantCacheReadAfter } from "../src/engine/context-policy";
import type { NeoConfig } from "../src/config";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";
import type { Order } from "../src/types";

function cfg(): NeoConfig {
  return {
    telegramToken: "",
    telegramAllowFrom: [],
    geminiApiKey: "",
    botUsername: "",
    webHost: "127.0.0.1",
    webPort: 3003,
    publicUrl: "",
    companyFolder: "/tmp/agent",
    gatewaySendUrl: "",
    providers: { ownWork: "subscription", customerWork: "gemini" },
    subscriptionInteractiveReservePct: 0.2,
    workRoot: "/home",
    budgetWindowUsd: 100,
    budgetWindowMs: 3_600_000,
    agentIngressSecret: "",
    idleCloseMs: 24 * 60 * 60 * 1000,
    stitchApiKey: "",
    gitnexusBin: "",
    codebaseMemoryBin: "",
    codebaseMemoryIndexTimeoutMs: 300_000,
    meetingLink: "",
    businessName: "",
    loopSchedulerEnabled: true,
    dispatchTimeoutMs: 900_000,
    dispatchTimeoutMaxMs: 7_200_000,
    dispatchStallMs: 300_000,
    dispatchGraceMs: 75_000,
    stuckAfterMs: 600_000,
    longTurnAlertMs: 1_200_000,
    alertRepeatMs: 900_000,
    drainWindowMs: 90_000,
    contextPolicy: {
      handoffPct: 0.65,
      emergencyPct: 0.85,
      maxTurns: 200,
      maxAgeMs: 604_800_000,
      handoffTimeoutMs: 180_000,
      staleResumePct: 0.35,
      cacheTtlFallbackMs: 3_600_000,
      cacheTtlMinObservations: 5,
    },
    workers: { company: { effort: "low" }, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: { effort: "low" }, handoff: {} },
    workerEnv: {},
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "neo-pipe-"));

// A controllable fake live session: completes only when finish() is called.
function fakeStart(opts: { onStart?: (h: RunHandlers) => void } = {}) {
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((res) => {
    resolveDone = res;
  });
  let resumeSeen: string | undefined;
  const followUps: string[] = [];
  const start = (_o: Order, h: RunHandlers, d?: { resume?: string }): SessionRun => {
    resumeSeen = d?.resume;
    opts.onStart?.(h);
    return { followUp: (t) => void followUps.push(t), interrupt: async () => {}, queued: () => 0, close: () => {}, done };
  };
  return { start, finish: (r: RunResult) => resolveDone(r), resumeSeen: () => resumeSeen, followUps: () => followUps };
}

function harness(over: { meter?: Meter; start?: ReturnType<typeof fakeStart>["start"] } = {}) {
  const replies: string[] = [];
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const meter = over.meter ?? createMeter({ windowBudgetUsd: 100, reservePct: 0.2 });
  const base = {
    cfg: cfg(),
    ledger,
    registry,
    meter,
    trust: openTrustStore(":memory:"),
    reply: (_c: number, t: string) => void replies.push(t),
    askApproval: async () => "allow" as const,
    start: over.start,
  };
  return { replies, ledger, registry, meter, base };
}

test("replies with a usage hint for a non-order message when no session is live", async () => {
  const h = harness();
  await handleMessage("nonsense", 1, h.base);
  expect(h.replies.some((r) => r.includes("/open"))).toBe(true);
});

test("starts a live order, streams text, registers it, then records the outcome on completion", async () => {
  const dir = scratch();
  const f = fakeStart({ onStart: (h) => h.onMessage("doing work") });
  const h = harness({ start: f.start });

  const run = await handleMessage(`/open ${dir} do the thing`, 9, h.base);
  expect(h.replies).toContain("doing work");
  expect(h.registry.list().length).toBe(1); // registered while running

  f.finish({ ok: true, sessionId: "sdk-1", summary: "completed", costUsd: 0.02 });
  await run!.done;

  expect(h.replies.some((r) => r.includes("completed"))).toBe(true);
  const recent = h.ledger.listRecent();
  expect(h.ledger.getOutcome(recent[0].id)?.status).toBe("done");
  // The finished project stays listed as IDLE (resumable/selectable), not deleted — the
  // idle watchdog or /kill removes it later. (Removing it on completion made opened
  // projects vanish from /list and the web dashboard within a second.)
  expect(h.registry.list().length).toBe(1);
  expect(h.registry.list()[0].status).toBe("idle");
  expect(h.registry.getControl(h.registry.list()[0].id)).toBeUndefined(); // dead handle dropped
});

test("logs the full conversation: inbound user text and every outbound reply", async () => {
  const dir = scratch();
  const f = fakeStart({ onStart: (h) => h.onMessage("doing work") });
  const h = harness({ start: f.start });

  const run = await handleMessage(`/open ${dir} do the thing`, 9, h.base);
  f.finish({ ok: true, sessionId: "sdk-1", summary: "completed", costUsd: 0 });
  await run!.done;

  const convo = h.ledger.conversation(9);
  expect(convo[0]).toMatchObject({ role: "user", content: `/open ${dir} do the thing` });
  expect(convo.some((m) => m.role === "assistant" && m.content === "doing work")).toBe(true);
  expect(convo.some((m) => m.role === "assistant" && m.content.includes("completed"))).toBe(true);
});

test("logs approval prompts and the operator's decision into the conversation", async () => {
  const dir = scratch();
  let captured!: RunHandlers;
  const f = fakeStart({ onStart: (h) => void (captured = h) });
  const h = harness({ start: f.start });

  await handleMessage(`/open ${dir} go`, 3, h.base);
  await captured.onEscalation("risky shell command: rm -rf build");

  const convo = h.ledger.conversation(3);
  expect(convo.some((m) => m.role === "assistant" && m.content.includes("rm -rf build"))).toBe(true);
  expect(convo.some((m) => m.role === "user" && m.content.includes("allow"))).toBe(true);
});

test("a follow-up to a completed (idle) session resumes it carrying its sdk id", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });

  const run = await handleMessage(`/open ${dir} start`, 4, h.base);
  f.finish({ ok: true, sessionId: "sdk-42", summary: "done", costUsd: 0 });
  await run!.done;
  await new Promise((r) => setTimeout(r, 0)); // let the supervisor mark it idle
  expect(h.registry.list()[0].status).toBe("idle");

  h.registry.setFocus(4, h.registry.list()[0].id, "once"); // explicitly re-address the idle project
  await handleMessage("now do part two", 4, h.base);

  expect(f.resumeSeen()).toBe("sdk-42"); // resumed with the persisted sdk session id
  expect(h.replies.some((r) => r.toLowerCase().includes("resum"))).toBe(true);
  expect(h.registry.list().length).toBe(1); // still the same single project
});

test("routes a plain-text message to the live session as a follow-up", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });

  await handleMessage(`/open ${dir} start`, 5, h.base);
  h.registry.setFocus(5, h.registry.list()[0].id, "pinned"); // explicitly address the running project
  await handleMessage("also write a README", 5, h.base);

  expect(f.followUps()).toContain("also write a README");
  expect(h.replies.some((r) => r.includes("queued for"))).toBe(true);
});

test("a free-text order with no active project routes to the default project", async () => {
  const f = fakeStart();
  const h = harness({ start: f.start });
  // a default (idle, resumable) project is registered — the chief-of-staff fallback
  const def = h.registry.add(
    { id: "def", source: "neo", folder: "/home/neo/agent", task: "init", chatId: -1, createdAt: 1 },
    1,
  );
  h.registry.setDefault(def.id);
  h.registry.setStatus(def.id, "idle");
  h.registry.setSdkSessionId(def.id, "sdk-def");

  await handleMessage("check docker status in eticket-v3", 9, h.base);

  expect(f.resumeSeen()).toBe("sdk-def"); // resumed the default project
  expect(h.replies.some((r) => r.includes("not an order"))).toBe(false);
  expect(h.replies.some((r) => r.toLowerCase().includes("resum"))).toBe(true);
});

test("throttles a new order when the meter is over the reserve, and does not start it", async () => {
  const dir = scratch();
  const meter = createMeter({ windowBudgetUsd: 10, reservePct: 0.2 }); // available $8
  meter.note({ costUsd: 9 }); // over reserve
  const f = fakeStart();
  const h = harness({ start: f.start, meter });

  await handleMessage(`/open ${dir} do it`, 1, h.base);

  expect(h.replies.some((r) => r.toLowerCase().includes("throttle"))).toBe(true);
  expect(h.registry.list().length).toBe(0);
});

test("refuses a customer-source order (firewall) and never starts it", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });

  await handleMessage(`/open ${dir} do it`, 1, h.base, "customer");

  expect(h.replies.some((r) => r.includes("refused"))).toBe(true);
  expect(h.registry.list().length).toBe(0);
});

test("wires worker escalations through askApproval", async () => {
  const dir = scratch();
  let asked = "";
  let captured!: RunHandlers;
  const f = fakeStart({ onStart: (h) => void (captured = h) });
  const h = harness({ start: f.start });
  const base = { ...h.base, askApproval: async (_c: number, reason: string) => ((asked = reason), "allow" as const) };

  await handleMessage(`/open ${dir} go`, 3, base);
  const decision = await captured.onEscalation("risky shell command: rm -rf build");

  expect(asked).toContain("rm");
  expect(decision).toBe("allow");
});

// A never-completing fake whose follow-ups are captured per folder (for focus/routing tests).
function routingStart(followed: string[]) {
  return (o: Order, _h: RunHandlers): SessionRun => ({
    followUp: (t) => void followed.push(`${o.folder}:${t}`),
    interrupt: async () => {},
    queued: () => 0,
    close: () => {},
    done: new Promise<RunResult>(() => {}),
  });
}

// Register an always-on company (default) so a reverted/unfocused chat has somewhere to land.
function withCompany(h: ReturnType<typeof harness>, followed: string[]): string {
  const companyDir = scratch();
  const company = h.registry.add(
    { id: "company", source: "neo", folder: companyDir, task: "standby", chatId: -1, createdAt: 0 },
    0,
  );
  h.registry.setDefault(company.id);
  h.registry.setStatus(company.id, "running"); // running so a plain message follows-up (captured)
  h.registry.attachControl(company.id, {
    followUp: (t) => void followed.push(`${companyDir}:${t}`),
    interrupt: async () => {},
    queued: () => 0,
  });
  return companyDir;
}

test("a follow-up routes to a one-shot-focused project", async () => {
  const dirA = scratch();
  const dirB = scratch();
  const followed: string[] = [];
  const h = harness({ start: routingStart(followed) });
  await handleMessage(`/open ${dirA} a`, 5, h.base);
  await handleMessage(`/open ${dirB} b`, 5, h.base);

  const aId = h.registry.list().find((s) => s.order.folder === dirA)!.id;
  h.registry.setFocus(5, aId, "once");
  await handleMessage("keep going", 5, h.base);

  expect(followed).toContain(`${dirA}:keep going`);
});

test("one-shot focus reverts to the company after ONE message", async () => {
  const dirA = scratch();
  const followed: string[] = [];
  const h = harness({ start: routingStart(followed) });
  const companyDir = withCompany(h, followed);
  await handleMessage(`/open ${dirA} a`, 5, h.base);
  const aId = h.registry.list().find((s) => s.order.folder === dirA)!.id;

  h.registry.setFocus(5, aId, "once");
  await handleMessage("first — goes to the project", 5, h.base);
  await handleMessage("second — should go to the company", 5, h.base);

  expect(followed).toContain(`${dirA}:first — goes to the project`);
  expect(followed).toContain(`${companyDir}:second — should go to the company`);
  expect(h.registry.getFocus(5)).toBeUndefined(); // focus consumed
});

test("a pinned project keeps receiving follow-ups until unpinned", async () => {
  const dirA = scratch();
  const followed: string[] = [];
  const h = harness({ start: routingStart(followed) });
  const companyDir = withCompany(h, followed);
  await handleMessage(`/open ${dirA} a`, 5, h.base);
  const aId = h.registry.list().find((s) => s.order.folder === dirA)!.id;

  h.registry.setFocus(5, aId, "pinned");
  await handleMessage("one", 5, h.base);
  await handleMessage("two", 5, h.base);
  h.registry.clearFocus(5);
  await handleMessage("three — back to company", 5, h.base);

  expect(followed).toContain(`${dirA}:one`);
  expect(followed).toContain(`${dirA}:two`);
  expect(followed).toContain(`${companyDir}:three — back to company`);
});

test("a busy project's follow-up reply reports the real status, not an opaque 'busy'", async () => {
  const dirA = scratch();
  const followed: string[] = [];
  const h = harness({ start: routingStart(followed) });
  await handleMessage(`/open ${dirA} a`, 5, h.base);
  const a = h.registry.list().find((s) => s.order.folder === dirA)!;
  h.registry.noteActivity(a.id, "running tests", 0);
  h.registry.setFocus(5, a.id, "pinned");

  await handleMessage("status?", 5, { ...h.base, now: () => 120_000 });

  const line = h.replies.find((r) => r.includes("queued for"))!;
  expect(line).toContain("running tests");
  expect(line).toContain("2m"); // activity age surfaced
});

test("resumes when a prior session id exists for the folder/chat", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });
  h.ledger.recordOrder({ id: "prev", source: "neo", folder: dir, task: "t", chatId: 7, createdAt: 1 });
  h.ledger.recordSession("prev", "sdk-prev");

  await handleMessage(`/open ${dir} continue`, 7, h.base);

  expect(f.resumeSeen()).toBe("sdk-prev");
  expect(h.replies.some((r) => r.toLowerCase().includes("resum"))).toBe(true);
});

test("worker output touches the session so producing output counts as activity", async () => {
  let handlers: RunHandlers | undefined;
  const fs = fakeStart({ onStart: (h) => (handlers = h) });
  const h = harness({ start: fs.start });
  let clock = 1000;
  await handleMessage("/open " + scratch() + " do work", 7, { ...h.base, now: () => clock });

  const id = h.registry.list()[0].id;
  clock = 5000;
  handlers!.onMessage("progress line"); // worker emits output at t=5000

  expect(h.registry.get(id)?.lastActivityAt).toBe(5000);
});

test("onActivity refreshes lastActivityAt (activity IS activity, not just onMessage)", async () => {
  let handlers: RunHandlers | undefined;
  const fs = fakeStart({ onStart: (h) => (handlers = h) });
  const h = harness({ start: fs.start });
  let clock = 1000;
  await handleMessage("/open " + scratch() + " do work", 7, { ...h.base, now: () => clock });

  const id = h.registry.list()[0].id;
  clock = 6000;
  handlers!.onActivity?.("Bash: bun test"); // activity only, no onMessage

  expect(h.registry.get(id)?.lastActivityAt).toBe(6000);
});

test("a trusted project auto-approves: onAutoApprove records to the ledger and replies", async () => {
  let handlers: RunHandlers | undefined;
  const fs = fakeStart({ onStart: (h) => (handlers = h) });
  const folder = scratch();
  const trust = openTrustStore(":memory:");
  trust.setTrust(folder, true);
  const h = harness({ start: fs.start });

  await handleMessage("/open " + folder + " do it", 7, { ...h.base, trust });

  expect(handlers!.autoApprove?.()).toBe(true);
  handlers!.onAutoApprove?.("risky shell command: git push");

  const orderId = h.ledger.listRecent(1)[0].id;
  expect(h.ledger.autoApprovalsFor(orderId)).toContain("risky shell command: git push");
  expect(h.replies.some((r) => r.includes("auto-approved"))).toBe(true);
});

test("pre-resume: clear verdict starts fresh instead of resuming a near-full session", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });
  h.ledger.recordOrder({ id: "p1", source: "neo", folder: dir, task: "x", chatId: 9, createdAt: 0 });
  h.ledger.recordSession("p1", "fat-id");

  await handleMessage(`/open ${dir} continue`, 9, {
    ...h.base,
    signals: () => ({ occupancy: 0.9, turns: 10, ageMs: 0, idleMs: 0 }), // emergency
  });

  expect(f.resumeSeen()).toBeUndefined(); // fresh, not resumed
  expect(h.ledger.lastSessionFor(dir, 9)).toBeUndefined(); // cleared
  expect(h.ledger.listContextEvents()[0]?.verdict).toBe("clear");
});

test("pre-resume: handoff verdict runs the handoff first, then starts fresh", async () => {
  const dir = scratch();
  const calls: string[] = [];
  const start = (_o: Order, _h: RunHandlers, d?: { resume?: string }): SessionRun => {
    calls.push(`start:${d?.resume ?? "fresh"}`);
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done: new Promise<never>(() => {}) } as unknown as SessionRun;
  };
  const h = harness({ start });
  h.ledger.recordOrder({ id: "p2", source: "neo", folder: dir, task: "x", chatId: 9, createdAt: 0 });
  h.ledger.recordSession("p2", "fat-2");

  await handleMessage(`/open ${dir} continue`, 9, {
    ...h.base,
    signals: () => ({ occupancy: 0.7, turns: 10, ageMs: 0, idleMs: 0 }),
    handoff: async (s) => {
      calls.push("handoff");
      h.ledger.clearSessionsFor(s.order.folder);
    },
  });

  expect(calls[0]).toBe("handoff");
  expect(calls[1]).toBe("start:fresh");
});

test("pre-resume gate: a configured windowTokensByModel flips the verdict (real sessionContext, no `signals` seam — proves the cfg override actually reaches this gate, not just sessionContext's own math)", async () => {
  const dir = scratch();
  const sdkId = "sdk-window-override";
  // A REAL transcript under sessionContext's default path (~/.claude/projects/<encodeCwd(dir)>/...)
  // — deliberately NOT using a `signals` test seam, so applyContextPolicy calls the real
  // sessionContext(folder, resumeId, { windowTokensByModel: deps.cfg.contextPolicy.windowTokensByModel }).
  const transcriptDir = join(homedir(), ".claude", "projects", encodeCwd(dir));
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, `${sdkId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { model: "big-model", usage: { input_tokens: 150_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }),
  );
  try {
    // Default 200k facts-map window: 150_000 / 200_000 = 0.75 >= handoffPct (0.65) → "handoff".
    const f1 = fakeStart();
    const h1 = harness({ start: f1.start });
    h1.ledger.recordOrder({ id: "d1", source: "neo", folder: dir, task: "x", chatId: 9, createdAt: 0 });
    h1.ledger.recordSession("d1", sdkId);
    const calls: string[] = [];
    await handleMessage(`/open ${dir} continue`, 9, {
      ...h1.base,
      handoff: async (s) => {
        calls.push("handoff");
        h1.ledger.clearSessionsFor(s.order.folder);
      },
    });
    expect(calls).toEqual(["handoff"]); // default facts map (no override) → handoff, same transcript
    expect(f1.resumeSeen()).toBeUndefined(); // fresh, not resumed

    // SAME transcript, but cfg now overrides "big-model"'s window to 1,000,000 tokens:
    // 150_000 / 1_000_000 = 0.15 — well under handoffPct → "keep" instead.
    const f2 = fakeStart();
    const h2 = harness({ start: f2.start });
    h2.ledger.recordOrder({ id: "d2", source: "neo", folder: dir, task: "x", chatId: 10, createdAt: 0 });
    h2.ledger.recordSession("d2", sdkId);
    const cfg2 = { ...h2.base.cfg, contextPolicy: { ...h2.base.cfg.contextPolicy, windowTokensByModel: { "big-model": 1_000_000 } } };
    await handleMessage(`/open ${dir} continue`, 10, { ...h2.base, cfg: cfg2 });
    expect(f2.resumeSeen()).toBe(sdkId); // kept — actually resumed with the persisted sdk session id
  } finally {
    rmSync(transcriptDir, { recursive: true, force: true });
  }
});

test("fresh start reads HANDOFF.md when it exists", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "HANDOFF.md"), "state");
  let seenTask = "";
  const start = (o: Order): SessionRun => {
    seenTask = o.task;
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done: new Promise<never>(() => {}) } as unknown as SessionRun;
  };
  const h = harness({ start });

  await handleMessage(`/open ${dir} continue the work`, 9, h.base);

  expect(seenTask.startsWith("Read HANDOFF.md first")).toBe(true);
});

test("a second message during a slow pre-resume handoff is queued, not a double-resume", async () => {
  const dir = scratch();
  const f = fakeStart();
  const h = harness({ start: f.start });

  // Get a real idle, resumable registry entry first (mirrors "a follow-up to a completed
  // (idle) session resumes it" above) — this is the branch F3 targets.
  const opened = await handleMessage(`/open ${dir} start`, 4, h.base);
  f.finish({ ok: true, sessionId: "sdk-1", summary: "done", costUsd: 0 });
  await opened!.done;
  await new Promise((r) => setTimeout(r, 0)); // let the supervisor mark it idle
  expect(h.registry.list()[0].status).toBe("idle");
  // Pin the project so BOTH plain messages address it (the F3 double-resume window under one focus).
  h.registry.setFocus(4, h.registry.list()[0].id, "pinned");

  let releaseHandoff!: () => void;
  const blocked = new Promise<void>((res) => {
    releaseHandoff = res;
  });
  let startCount = 0;
  const countingStart: typeof f.start = (o, hn, d) => {
    startCount++;
    return f.start(o, hn, d);
  };
  const base = {
    ...h.base,
    start: countingStart,
    signals: () => ({ occupancy: 0.7, turns: 10, ageMs: 0, idleMs: 0 }), // handoff verdict
    handoff: async () => {
      await blocked; // simulate a slow (bounded) handoff turn
    },
  };

  const first = handleMessage("continue please", 4, base); // triggers idle-resume + handoff
  await new Promise((r) => setTimeout(r, 0)); // let it reach the await
  await handleMessage("second message while resuming", 4, base);

  expect(h.replies.some((r) => r.toLowerCase().includes("reopening"))).toBe(true);
  expect(startCount).toBe(0); // no start yet — still blocked on handoff

  releaseHandoff();
  await first;
  await new Promise((r) => setTimeout(r, 0));
  expect(startCount).toBe(1); // exactly one start, once the handoff released
});

test("post-completion handoff fires when the finished session is fat", async () => {
  const dir = scratch();
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((res) => {
    resolveDone = res;
  });
  const start = (): SessionRun =>
    ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, done }) as unknown as SessionRun;
  let handoffCalled = false;
  const h = harness({ start });

  await handleMessage(`/open ${dir} work`, 9, {
    ...h.base,
    signals: () => ({ occupancy: 0.7, turns: 10, ageMs: 0, idleMs: 0 }),
    handoff: async () => {
      handoffCalled = true;
    },
  });
  resolveDone({ ok: true, sessionId: "s-done", summary: "done", costUsd: 0 });
  await new Promise((r) => setTimeout(r, 0));

  expect(handoffCalled).toBe(true);
});

// --- LEARNED cache-TTL observation recording (2026-07-23 review finding: reading the transcript's
// LAST turn instead of the FIRST post-resume turn would starve the misses bucket, since a later
// turn in the same run already hits the cache the first turn just rewarmed). ---

// Real transcripts are newline-terminated on EVERY line, including the last (`~/.claude/projects/
// .../*.jsonl` always ends `}\n`) — a fixture that omits the final "\n" sidesteps the trailing-
// newline off-by-one that `.split("\n")` introduces (a naive count picks up a phantom trailing ""
// element). These fixtures deliberately match that real byte layout: every write/append ends
// its last line with "\n" too.
function assistantLine(cacheRead: number): string {
  return JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: cacheRead } } }) + "\n";
}

test("resume records a cache observation from the FIRST post-resume turn, not a later one in the same run", async () => {
  const dir = scratch();
  const projectsDir = scratch(); // stand-in for ~/.claude/projects, isolated from the real homedir
  const sdkId = "sdk-cache-1";
  const transcriptDir = join(projectsDir, encodeCwd(dir));
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `${sdkId}.jsonl`);
  // Pre-resume transcript: one prior turn, newline-terminated like a real transcript — its line
  // count is the boundary a post-resume scan must start strictly AFTER.
  writeFileSync(transcriptPath, assistantLine(999));

  const seams = {
    lineCount: (folder: string, id: string) => transcriptLineCount(folder, id, { projectsDir }),
    cacheRead: (folder: string, id: string, afterLine: number) => firstAssistantCacheReadAfter(folder, id, afterLine, { projectsDir }),
  };

  // Open + finish so the session is idle/resumable with its sdk id persisted.
  let resolve1!: (r: RunResult) => void;
  const done1 = new Promise<RunResult>((res) => (resolve1 = res));
  const start1 = (): SessionRun =>
    ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, close: () => {}, done: done1 }) as unknown as SessionRun;
  const h = harness({ start: start1 });
  const opened = await handleMessage(`/open ${dir} start`, 4, { ...h.base, ...seams });
  resolve1({ ok: true, sessionId: sdkId, summary: "done", costUsd: 0 });
  await opened!.done;
  await new Promise((r) => setTimeout(r, 0));
  h.registry.setFocus(4, h.registry.list()[0].id, "once");

  let resolve2!: (r: RunResult) => void;
  const done2 = new Promise<RunResult>((res) => (resolve2 = res));
  const start2 = (): SessionRun =>
    ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, close: () => {}, done: done2 }) as unknown as SessionRun;
  const resumed = await handleMessage("continue", 4, {
    ...h.base,
    start: start2,
    ...seams,
    signals: () => ({ occupancy: 0.1, turns: 1, ageMs: 0, idleMs: 999 }), // well under every threshold → "keep"
  });
  // Only NOW (after the gate has already read the pre-resume line count) simulate the SDK
  // appending this resume's turns, each newline-terminated like a real transcript: the FIRST is a
  // real cache miss (0); a LATER turn in the SAME run already re-hit the cache the first turn just
  // warmed. The old (last-turn) bug, and the trailing-newline off-by-one that survived its fix,
  // would both have landed on this LATER turn and recorded hit:true — this pins hit:false instead.
  appendFileSync(transcriptPath, assistantLine(0) + assistantLine(500));
  resolve2({ ok: true, sessionId: sdkId, summary: "done again", costUsd: 0 });
  await resumed!.done;
  await new Promise((r) => setTimeout(r, 0));

  const obs = h.ledger.listCacheObservations(10);
  expect(obs).toHaveLength(1);
  expect(obs[0]).toMatchObject({ gapMs: 999, hit: false }); // first post-resume turn's cache_read was 0
});

test("resume finds a SINGLE appended post-resume turn (no off-by-one when there's only one new line)", async () => {
  const dir = scratch();
  const projectsDir = scratch();
  const sdkId = "sdk-cache-3";
  const transcriptDir = join(projectsDir, encodeCwd(dir));
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `${sdkId}.jsonl`);
  writeFileSync(transcriptPath, assistantLine(999)); // pre-resume, newline-terminated

  const seams = {
    lineCount: (folder: string, id: string) => transcriptLineCount(folder, id, { projectsDir }),
    cacheRead: (folder: string, id: string, afterLine: number) => firstAssistantCacheReadAfter(folder, id, afterLine, { projectsDir }),
  };

  let resolve1!: (r: RunResult) => void;
  const done1 = new Promise<RunResult>((res) => (resolve1 = res));
  const start1 = (): SessionRun =>
    ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, close: () => {}, done: done1 }) as unknown as SessionRun;
  const h = harness({ start: start1 });
  const opened = await handleMessage(`/open ${dir} start`, 5, { ...h.base, ...seams });
  resolve1({ ok: true, sessionId: sdkId, summary: "done", costUsd: 0 });
  await opened!.done;
  await new Promise((r) => setTimeout(r, 0));
  h.registry.setFocus(5, h.registry.list()[0].id, "once");

  let resolve2!: (r: RunResult) => void;
  const done2 = new Promise<RunResult>((res) => (resolve2 = res));
  const start2 = (): SessionRun =>
    ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, close: () => {}, done: done2 }) as unknown as SessionRun;
  const resumed = await handleMessage("continue", 5, {
    ...h.base,
    start: start2,
    ...seams,
    signals: () => ({ occupancy: 0.1, turns: 1, ageMs: 0, idleMs: 42 }),
  });
  // Exactly ONE post-resume turn appended — a stale `afterLine` (one index too far) would land past
  // it and no-op (lossy but safe); the fix must still find it.
  appendFileSync(transcriptPath, assistantLine(777));
  resolve2({ ok: true, sessionId: sdkId, summary: "done again", costUsd: 0 });
  await resumed!.done;
  await new Promise((r) => setTimeout(r, 0));

  const obs = h.ledger.listCacheObservations(10);
  expect(obs).toHaveLength(1);
  expect(obs[0]).toMatchObject({ gapMs: 42, hit: true }); // the single new turn's cache_read was 777 (> 0)
});

test("a forked resume (SDK returned a NEW session id, not the one resumed) records NOTHING — a fresh transcript's first turn is cold by construction, not a real idle-gap miss", async () => {
  const dir = scratch();
  const projectsDir = scratch();
  const sdkId = "sdk-cache-fork-1";
  const forkedId = "sdk-cache-fork-2";
  const transcriptDir = join(projectsDir, encodeCwd(dir));
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(transcriptDir, `${sdkId}.jsonl`), assistantLine(999)); // pre-resume, newline-terminated

  let cacheReadCalls = 0;
  const seams = {
    lineCount: (folder: string, id: string) => transcriptLineCount(folder, id, { projectsDir }),
    cacheRead: (folder: string, id: string, afterLine: number) => {
      cacheReadCalls++;
      return firstAssistantCacheReadAfter(folder, id, afterLine, { projectsDir });
    },
  };

  let resolve1!: (r: RunResult) => void;
  const done1 = new Promise<RunResult>((res) => (resolve1 = res));
  const start1 = (): SessionRun =>
    ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, close: () => {}, done: done1 }) as unknown as SessionRun;
  const h = harness({ start: start1 });
  const opened = await handleMessage(`/open ${dir} start`, 7, { ...h.base, ...seams });
  resolve1({ ok: true, sessionId: sdkId, summary: "done", costUsd: 0 });
  await opened!.done;
  await new Promise((r) => setTimeout(r, 0));
  h.registry.setFocus(7, h.registry.list()[0].id, "once");

  let resolve2!: (r: RunResult) => void;
  const done2 = new Promise<RunResult>((res) => (resolve2 = res));
  const start2 = (): SessionRun =>
    ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, close: () => {}, done: done2 }) as unknown as SessionRun;
  const resumed = await handleMessage("continue", 7, {
    ...h.base,
    start: start2,
    ...seams,
    signals: () => ({ occupancy: 0.1, turns: 1, ageMs: 0, idleMs: 42 }), // well under every threshold → "keep"
  });
  // The SDK forked: we asked to resume sdkId, but the run reports a DIFFERENT session id — a brand
  // new transcript file whose first turn is cold BY CONSTRUCTION (fresh cache, not a real idle-gap
  // miss). Give it a real cache-miss-shaped first turn so this proves the fix skips a REAL-looking
  // read too, not just one that happens to fail open because the file is missing.
  writeFileSync(join(transcriptDir, `${forkedId}.jsonl`), assistantLine(0));
  resolve2({ ok: true, sessionId: forkedId, summary: "done again", costUsd: 0 });
  await resumed!.done;
  await new Promise((r) => setTimeout(r, 0));

  expect(cacheReadCalls).toBe(0); // skip, don't guess — the forked case is never even inspected
  expect(h.ledger.listCacheObservations(10)).toHaveLength(0); // and never poisoned with a false miss
});

test("resume records nothing when the pre-resume line count can't be measured (fail-open, no false miss)", async () => {
  const dir = scratch();
  const sdkId = "sdk-cache-2";
  const missingProjectsDir = join(scratch(), "does-not-exist"); // never created — every read fails open
  const seams = {
    lineCount: (folder: string, id: string) => transcriptLineCount(folder, id, { projectsDir: missingProjectsDir }),
    cacheRead: (folder: string, id: string, afterLine: number) =>
      firstAssistantCacheReadAfter(folder, id, afterLine, { projectsDir: missingProjectsDir }),
  };

  let resolve1!: (r: RunResult) => void;
  const done1 = new Promise<RunResult>((res) => (resolve1 = res));
  const start1 = (): SessionRun =>
    ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, close: () => {}, done: done1 }) as unknown as SessionRun;
  const h = harness({ start: start1 });
  const opened = await handleMessage(`/open ${dir} start`, 6, { ...h.base, ...seams });
  resolve1({ ok: true, sessionId: sdkId, summary: "done", costUsd: 0 });
  await opened!.done;
  await new Promise((r) => setTimeout(r, 0));
  h.registry.setFocus(6, h.registry.list()[0].id, "once");

  let resolve2!: (r: RunResult) => void;
  const done2 = new Promise<RunResult>((res) => (resolve2 = res));
  const start2 = (): SessionRun =>
    ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, close: () => {}, done: done2 }) as unknown as SessionRun;
  const resumed = await handleMessage("continue", 6, {
    ...h.base,
    start: start2,
    ...seams,
    signals: () => ({ occupancy: 0.1, turns: 1, ageMs: 0, idleMs: 999 }),
  });
  resolve2({ ok: true, sessionId: sdkId, summary: "done again", costUsd: 0 });
  await resumed!.done;
  await new Promise((r) => setTimeout(r, 0));

  expect(h.ledger.listCacheObservations(10)).toEqual([]);
});

test("startSession wires onActivity into registry.noteActivity", async () => {
  let captured: RunHandlers | undefined;
  const fakeStartFn = (_o: Order, h: RunHandlers) => {
    captured = h;
    return { followUp: () => {}, interrupt: async () => {}, queued: () => 0, done: new Promise<never>(() => {}) } as unknown as SessionRun;
  };
  const h = harness({ start: fakeStartFn as never });
  await handleMessage("/open " + scratch() + " do a thing", 7, h.base);
  const session = h.registry.list()[0];
  captured?.onActivity?.("Bash: bun test");
  expect(h.registry.get(session.id)?.activity?.label).toBe("Bash: bun test");
});
