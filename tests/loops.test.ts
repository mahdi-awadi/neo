import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { handleLoop, startLoop, startScheduledLoop, matchLoop, listLoops, loopProjectTag, createLoop, updateLoop, deleteLoop, effectiveLoops, type LoopDef } from "../src/engine/loops";
import { openLedger } from "../src/engine/ledger";
import { encodeCwd } from "../src/engine/context-policy";
import type { LoopInput } from "../src/engine/loop-validate";
import type { RunResult, RunDeps } from "../src/engine/session-runner";
import type { NeoConfig } from "../src/config";

const okRun = (sid = "s"): RunResult => ({ ok: true, sessionId: sid, summary: "", costUsd: 0 });
const defMethods = { listLoopDefs: () => [], saveLoopDef: () => {}, deleteLoopDef: () => {}, listCacheObservations: () => [] };
const cinput = (over: Partial<LoopInput> = {}): LoopInput => ({
  name: "nightly-fmt",
  summary: "fmt",
  folder: "/home/neo",
  prompt: "do it",
  goalKind: "command",
  goalCommand: "true",
  triggerKind: "cron",
  cronExpr: "0 4 * * *",
  maxIterations: 3,
  ...over,
});

test("matchLoop normalizes '<project> <goal>' and finds the loop", () => {
  expect(matchLoop("docs sweep")?.name).toBe("docs-sweep");
  expect(matchLoop("docs-sweep")?.name).toBe("docs-sweep");
  expect(matchLoop("DOCS   SWEEP")?.name).toBe("docs-sweep"); // case + extra spaces
  expect(matchLoop("nope")).toBeUndefined();
});

test("listLoops returns the available loops with name/usage/summary", () => {
  const ls = listLoops();
  const sweep = ls.find((l) => l.name === "docs-sweep");
  expect(sweep).toBeTruthy();
  expect(sweep?.usage).toContain("/loop");
  expect(typeof sweep?.summary).toBe("string");
});

test("handleLoop ignores non-loop text", () => {
  expect(handleLoop("hello there", 1, { reply: () => {} })).toBe(false);
  expect(handleLoop("/list", 1, { reply: () => {} })).toBe(false);
});

test("/loop with no args lists the available loops", () => {
  const replies: string[] = [];
  expect(handleLoop("/loop", 1, { reply: (_c, t) => void replies.push(t) })).toBe(true);
  expect(replies.join("\n").toLowerCase()).toContain("green");
});

test("/loop with an unknown loop replies with the list", () => {
  const replies: string[] = [];
  handleLoop("/loop wat huh", 1, { reply: (_c, t) => void replies.push(t) });
  expect(replies.join("\n").toLowerCase()).toContain("green");
});

test("startLoop runs the loop, streams progress, and reports the outcome", async () => {
  const replies: string[] = [];
  let ran = 0;
  let n = 0;
  const out = await startLoop(matchLoop("green")!, 1, {
    reply: (_c, t) => void replies.push(t),
    run: async (_o, h) => {
      ran++;
      h.onMessage("formatting");
      return okRun();
    },
    check: async () => ({ met: n++ > 0, detail: `c${n}` }), // not met, then met
  });
  expect(out.met).toBe(true);
  expect(ran).toBe(1);
  expect(replies.some((r) => r.toLowerCase().includes("start"))).toBe(true);
  expect(replies.some((r) => r.toLowerCase().includes("goal met"))).toBe(true);
});

// A fire-once reminder-style scheduled loop (like a nightly hearings reminder): one iteration,
// goal never met on its own, folder under /home so its project tag is the basename.
const remLoop = (folder = "/home/acme"): LoopDef => ({
  name: "rem",
  usage: "/loop rem",
  summary: "reminder",
  folder,
  prompt: "check hearings",
  goal: { kind: "command", command: ["sh", "-c", "false"] },
  trigger: { kind: "cron", expr: "0 4 * * *" },
  bounds: { maxIterations: 1 },
});

test("startScheduledLoop forwards worker text to the operator channel tagged with the loop's project, no chrome", async () => {
  const replies: Array<{ chatId: number; text: string; project?: string }> = [];
  const out = await startScheduledLoop(remLoop(), {
    chatId: 4242,
    reply: (chatId, text, project) => void replies.push({ chatId, text, project }),
    run: async (_o, h) => {
      h.onMessage("You have a hearing tomorrow at 9am (case #123).");
      return okRun();
    },
    check: async () => ({ met: false, detail: "no hearings check" }),
  });
  expect(out.iterations).toBe(1);
  // Exactly the worker's line reaches the operator, tagged with the folder-derived project.
  expect(replies).toEqual([
    { chatId: 4242, text: "You have a hearing tomorrow at 9am (case #123).", project: "acme" },
  ]);
  // No starting / iteration / outcome chrome — only real worker output.
  expect(replies.some((r) => /start|iteration|goal met|⚠️|🔁/i.test(r.text))).toBe(false);
});

test("startScheduledLoop stays silent when the worker produces no text (silent success)", async () => {
  const replies: string[] = [];
  await startScheduledLoop(remLoop(), {
    chatId: 1,
    reply: (_c, t) => void replies.push(t),
    run: async () => okRun(), // worker emits no assistant text
    check: async () => ({ met: false, detail: "" }),
  });
  expect(replies).toEqual([]); // nothing forwarded → no per-iteration spam
});

// Full NeoConfig fixture (2026-07-23 review finding #7): loopRunExtras derives BOTH the per-path
// worker profile (profileDeps(cfg, "loop")) and the context-policy resume gate from `cfg` — this
// proves a real `cfg` actually reaches runProjectLoop's iterate() call, not just that the plumbing
// compiles.
function loopCfg(over: Partial<NeoConfig> = {}): NeoConfig {
  return {
    telegramToken: "",
    telegramAllowFrom: [],
    geminiApiKey: "",
    botUsername: "",
    webHost: "127.0.0.1",
    webPort: 3003,
    publicUrl: "",
    providers: { ownWork: "subscription", customerWork: "gemini" },
    subscriptionInteractiveReservePct: 0.2,
    workRoot: "/home",
    companyFolder: "/tmp/agent",
    budgetWindowUsd: 100,
    budgetWindowMs: 3_600_000,
    agentIngressSecret: "",
    gatewaySendUrl: "",
    idleCloseMs: 24 * 60 * 60 * 1000,
    stitchApiKey: "",
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
    workers: { company: {}, project: {}, dispatch: {}, loop: { model: "loop-test-model" }, judge: {}, ingress: {}, handoff: {} },
    workerEnv: {},
    memory: { scopes: [], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 },
    ...over,
  };
}

test("startScheduledLoop wires loopRunExtras' runDeps + context-policy resume gate into runProjectLoop's iterate() calls", async () => {
  const folder = "/home/neo-loop-gate-fixture";
  const sdkId = "sdk-loop-gate-fat";
  const transcriptDir = join(homedir(), ".claude", "projects", encodeCwd(folder));
  mkdirSync(transcriptDir, { recursive: true });
  // A fat pre-resume transcript: 150k input-side tokens against the default 200k window = 0.75
  // occupancy, ≥ contextPolicy.handoffPct (0.65) → the gate should drop this resume.
  writeFileSync(
    join(transcriptDir, `${sdkId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { usage: { input_tokens: 150_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n",
  );
  const loop: LoopDef = { ...remLoop(folder), bounds: { maxIterations: 5 } };
  try {
    // Case 1 (default facts-map window): the gate sees the fat transcript and drops the resume —
    // iteration 2 must run WITHOUT the sdk id it would otherwise have carried.
    const dropped: Array<{ resume?: string; model?: string }> = [];
    let n1 = 0;
    const out1 = await startScheduledLoop(loop, {
      chatId: 1,
      reply: () => {},
      cfg: loopCfg(),
      run: async (_o, _h, runDeps) => {
        dropped.push({ resume: runDeps?.resume, model: runDeps?.model });
        return okRun(sdkId);
      },
      check: async () => ({ met: n1++ >= 2, detail: "" }),
    });
    expect(out1.iterations).toBe(2);
    expect(dropped).toHaveLength(2);
    expect(dropped[0].resume).toBeUndefined(); // first iteration: nothing to resume yet
    expect(dropped[1].resume).toBeUndefined(); // second: the gate saw sdkId and dropped it (fat transcript)
    // profileDeps(cfg, "loop") reached the run call on BOTH iterations.
    expect(dropped[0].model).toBe("loop-test-model");
    expect(dropped[1].model).toBe("loop-test-model");

    // Case 2 — same transcript, but a windowTokensByModel override widens the window so occupancy
    // drops well under handoffPct: the SAME gate now KEEPS the resume, proving case 1 wasn't a
    // no-op (the gate is actually wired to cfg, not bypassed).
    const kept: Array<{ resume?: string; model?: string }> = [];
    let n2 = 0;
    const wideCfg = loopCfg({ contextPolicy: { ...loopCfg().contextPolicy, windowTokensByModel: { default: 1_000_000 } } });
    await startScheduledLoop(loop, {
      chatId: 1,
      reply: () => {},
      cfg: wideCfg,
      run: async (_o, _h, runDeps) => {
        kept.push({ resume: runDeps?.resume, model: runDeps?.model });
        return okRun(sdkId);
      },
      check: async () => ({ met: n2++ >= 2, detail: "" }),
    });
    expect(kept[1].resume).toBe(sdkId); // gate kept it — the resume id actually reached iterate()
  } finally {
    rmSync(transcriptDir, { recursive: true, force: true });
  }
});

test("/loop <name> on enables a scheduled loop via the store", () => {
  const replies: string[] = [];
  const enabled = new Map<string, boolean>();
  const store = {
    getLastRun: () => undefined,
    setLastRun: () => {},
    isEnabled: (n: string) => enabled.get(n),
    setEnabled: (n: string, on: boolean) => void enabled.set(n, on),
    ...defMethods,
  };
  const handled = handleLoop("/loop docs-sweep on", 1, { reply: (_c, t) => void replies.push(t), store });
  expect(handled).toBe(true);
  expect(enabled.get("docs-sweep")).toBe(true);
  expect(replies.join("\n").toLowerCase()).toContain("on");
});

test("/loop <name> off disables it", () => {
  const enabled = new Map<string, boolean>([["docs-sweep", true]]);
  const store = {
    getLastRun: () => undefined,
    setLastRun: () => {},
    isEnabled: (n: string) => enabled.get(n),
    setEnabled: (n: string, on: boolean) => void enabled.set(n, on),
    ...defMethods,
  };
  handleLoop("/loop docs-sweep off", 1, { reply: () => {}, store });
  expect(enabled.get("docs-sweep")).toBe(false);
});

test("createLoop persists a custom loop that then appears in the merged set", () => {
  const led = openLedger(":memory:");
  const r = createLoop(cinput(), led);
  expect(r.ok).toBe(true);
  expect(matchLoop("nightly-fmt", led)?.name).toBe("nightly-fmt");
  expect(effectiveLoops(led).some((l) => l.name === "nightly-fmt")).toBe(true);
  expect(listLoops(led).find((l) => l.name === "nightly-fmt")?.custom).toBe(true);
});

test("createLoop rejects a name that collides with a built-in", () => {
  const led = openLedger(":memory:");
  expect(createLoop(cinput({ name: "green" }), led).ok).toBe(false);
});

test("built-ins win over a custom row with the same name", () => {
  const led = openLedger(":memory:");
  led.saveLoopDef("green", JSON.stringify({ name: "green", folder: "/x", goal: {}, trigger: {}, bounds: {} }));
  expect(effectiveLoops(led).filter((l) => l.name === "green")).toHaveLength(1);
  expect(matchLoop("green", led)?.folder).toBe(process.cwd()); // the built-in (self-repo), not the custom row
});

test("updateLoop and deleteLoop reject built-ins, accept custom", () => {
  const led = openLedger(":memory:");
  createLoop(cinput(), led);
  expect(updateLoop("green", cinput(), led).ok).toBe(false);
  expect(deleteLoop("green", led).ok).toBe(false);
  expect(updateLoop("nightly-fmt", cinput({ summary: "fmt v2" }), led).ok).toBe(true);
  expect(matchLoop("nightly-fmt", led)?.summary).toBe("fmt v2");
  expect(deleteLoop("nightly-fmt", led).ok).toBe(true);
  expect(matchLoop("nightly-fmt", led)).toBeUndefined();
});

test("effectiveLoops skips unparseable custom rows", () => {
  const led = openLedger(":memory:");
  led.saveLoopDef("broken", "{not json");
  expect(effectiveLoops(led).some((l) => l.name === "broken")).toBe(false);
});

test("mywellbeing-checkin is a fire-once daily-morning wellbeing loop", () => {
  const loop = matchLoop("mywellbeing-checkin");
  expect(loop).toBeTruthy();
  // Fire-once: a NEVER-met command goal + a single iteration. runLoop checks the goal BEFORE each
  // iteration, so a truthy/met goal would skip the run entirely — the check-in must use a goal that
  // never holds so exactly one iteration fires (docs/loops.md gotcha; mirrors the remLoop fixture).
  expect(loop!.goal).toEqual({ kind: "command", command: ["sh", "-c", "false"] });
  expect(loop!.bounds.maxIterations).toBe(1);
  // Small budget cap, in line with the other built-ins (green 5, sweeps 10).
  expect(loop!.bounds.budgetUsd).toBeGreaterThan(0);
  expect(loop!.bounds.budgetUsd).toBeLessThanOrEqual(5);
  // Scheduled: cron, once each morning (06:00 server-local ≈ 09:00 Asia/Baghdad under a UTC clock).
  expect(loop!.trigger).toEqual({ kind: "cron", expr: "0 6 * * *" });
  // Project tag = folder basename, so a scheduled fire streams its text tagged #mywell-being.
  expect(loop!.folder).toBe("/home/mywell-being");
  expect(loopProjectTag(loop!)).toBe("mywell-being");
  // Disabled until the operator turns it on with `/loop mywellbeing-checkin on`.
  expect(loop!.enabledByDefault).toBe(false);
  // The action drives the project's daily check-in (diabetes/sleep) and emits it AS TEXT — only the
  // worker's text reaches the operator, so the prompt must make it write the questions/proposals out.
  const p = loop!.prompt.toLowerCase();
  expect(p).toContain("check-in");
  expect(p).toContain("glucose");
  expect(p).toContain("text"); // instructs the worker to emit its check-in as its text reply
});

// PIN: memory-dream exists and is disabled by default — a fresh clone / an operator who never
// touches config.json gets no behavior change (the scheduler skips every disabled loop).
test("effectiveLoops contains memory-dream, disabled by default (default scheduler behavior unchanged)", () => {
  const loop = matchLoop("memory-dream");
  expect(loop).toBeTruthy();
  expect(loop!.enabledByDefault).toBe(false);
  expect(loop!.trigger).toEqual({ kind: "cron", expr: "0 3 * * *" });
  expect(loop!.bounds.maxIterations).toBe(1);
  expect(effectiveLoops().some((l) => l.name === "memory-dream")).toBe(true);
});

// Reads a `tool()`-built SDK tool's handler off an in-process McpServer instance the same way
// dispatch.test.ts's neoToolNames helper does (createSdkMcpServer exposes its registered tools on
// `.instance._registeredTools` at runtime — there's no public API to call a tool without going
// through the full MCP wire protocol).
function toolHandler(
  servers: Record<string, unknown> | undefined,
  serverName: string,
  toolName: string,
): ((args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>) | undefined {
  const server = servers?.[serverName] as { instance?: { _registeredTools?: Record<string, unknown> } } | undefined;
  const tool = server?.instance?._registeredTools?.[toolName] as
    | { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }
    | undefined;
  return tool?.handler;
}

test("startLoop wires a dream-budgeted memory MCP server into ONLY the memory-dream loop's runDeps — a normal loop (green) gets none", async () => {
  const companyFolder = mkdtempSync(join(tmpdir(), "neo-dream-"));
  try {
    const cfg = loopCfg({
      companyFolder,
      memory: { scopes: ["company"], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 5, dreamMaxNetChars: 10_000, dreamLookbackDays: 7 },
    });

    let dreamRunDeps: RunDeps | undefined;
    let n1 = 0;
    await startLoop(matchLoop("memory-dream")!, 1, {
      reply: () => {},
      cfg,
      run: async (_o, _h, runDeps) => {
        dreamRunDeps = runDeps;
        return okRun();
      },
      check: async () => ({ met: n1++ > 0, detail: "" }), // not met, then met → exactly one iterate()
    });

    const memoryHandler = toolHandler(dreamRunDeps?.mcpServers, "memory", "memory");
    expect(memoryHandler).toBeTruthy();
    // Dream budgets are LIVE on this server: drive 3 successful adds (dreamMaxMutations: 3), then
    // watch the 4th get rejected by the SAME budget closure — proving this isn't just tool presence.
    for (let i = 0; i < 3; i++) {
      const res = await memoryHandler!({ file: "MEMORY.md", op: "add", text: `dream fact ${i}`, reason: "test" }, {});
      expect(res.content[0]?.text).toContain("saved");
    }
    const over = await memoryHandler!({ file: "MEMORY.md", op: "add", text: "one too many", reason: "test" }, {});
    expect(over.content[0]?.text).toContain("dream budget exhausted");
    // The dream diary landed in the company folder, not somewhere else.
    expect(existsSync(join(companyFolder, "memory", "DREAMS.md"))).toBe(true);

    let greenRunDeps: RunDeps | undefined;
    let n2 = 0;
    await startLoop(matchLoop("green")!, 1, {
      reply: () => {},
      cfg,
      run: async (_o, _h, runDeps) => {
        greenRunDeps = runDeps;
        return okRun();
      },
      check: async () => ({ met: n2++ > 0, detail: "" }),
    });
    expect(greenRunDeps?.mcpServers).toBeUndefined();
  } finally {
    rmSync(companyFolder, { recursive: true, force: true });
  }
});

test("startLoop no-ops the memory-dream loop (no worker started) when the company folder isn't in memory.scopes", async () => {
  const companyFolder = mkdtempSync(join(tmpdir(), "neo-dream-unscoped-"));
  try {
    const cfg = loopCfg({ companyFolder, memory: { ...loopCfg().memory, scopes: [] } }); // NOT scoped
    let ran = false;
    const replies: string[] = [];
    const out = await startLoop(matchLoop("memory-dream")!, 1, {
      reply: (_c, t) => void replies.push(t),
      cfg,
      run: async () => {
        ran = true;
        return okRun();
      },
      check: async () => ({ met: false, detail: "" }),
    });
    expect(ran).toBe(false); // no worker started — the gate trips BEFORE runProjectLoop
    expect(out.iterations).toBe(0);
    expect(replies.some((r) => r.includes("memory disabled (company not in memory.scopes)"))).toBe(true);
  } finally {
    rmSync(companyFolder, { recursive: true, force: true });
  }
});
