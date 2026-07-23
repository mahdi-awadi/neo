import { test, expect } from "bun:test";
import { tickScheduler, folderBusy, type SchedulableLoop, type LoopStateStore } from "../src/engine/scheduler";
import { createRegistry } from "../src/engine/registry";
import { matchLoop, resolveDreamLoop } from "../src/engine/loops";
import type { NeoConfig } from "../src/config";

function memStore(init: Record<string, { lastRun?: number; enabled?: boolean }> = {}): LoopStateStore {
  const s = new Map(Object.entries(init));
  return {
    getLastRun: (n) => s.get(n)?.lastRun,
    setLastRun: (n, at) => void s.set(n, { ...s.get(n), lastRun: at }),
    isEnabled: (n) => s.get(n)?.enabled,
    setEnabled: (n, on) => void s.set(n, { ...s.get(n), enabled: on }),
  };
}
const loop = (over: Partial<SchedulableLoop> = {}): SchedulableLoop => ({
  name: "l",
  folder: "/p",
  trigger: { kind: "interval", everyMs: 1000 },
  enabledByDefault: true,
  ...over,
});

test("fires a due, enabled, free, unthrottled loop and records lastRun before starting", () => {
  const started: string[] = [];
  const store = memStore();
  tickScheduler({ loops: [loop()], store, isFolderBusy: () => false, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual(["l"]);
  expect(store.getLastRun("l")).toBe(10_000);
});

test("skips when the folder is busy", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop()], store: memStore(), isFolderBusy: () => true, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

test("skips when throttled", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop()], store: memStore(), isFolderBusy: () => false, throttled: () => true, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

test("explicit disabled overrides enabledByDefault", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop()], store: memStore({ l: { enabled: false } }), isFolderBusy: () => false, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

test("skips manual loops entirely", () => {
  const started: string[] = [];
  tickScheduler({ loops: [loop({ trigger: { kind: "manual" } })], store: memStore(), isFolderBusy: () => false, throttled: () => false, now: 10_000, start: (d) => started.push(d.name) });
  expect(started).toEqual([]);
});

// --- folderBusy: the company-folder-aware busy predicate (daemon.ts's isFolderBusy) -------------
// The always-on default project is registered IDLE forever (registerDefaultProject), so a plain
// presence check ("is there an OPEN session for this folder") would see the company folder as
// permanently busy and starve any loop scheduled against it (e.g. memory-dream). folderBusy fixes
// this WITHOUT changing behavior for every other folder, which keeps today's presence semantics
// (an OPEN session — running OR idle — still counts as busy).

test("folderBusy: no session registered for the folder → not busy", () => {
  const registry = createRegistry();
  expect(folderBusy(registry, "/company", "/company")).toBe(false);
});

test("folderBusy: the COMPANY folder with only an IDLE session → NOT busy (the always-on default project must never starve a company-scheduled loop)", () => {
  const registry = createRegistry();
  const s = registry.add({ id: "c", source: "neo", folder: "/company", task: "", chatId: -1, createdAt: 0 }, 0);
  registry.setStatus(s.id, "idle");
  expect(folderBusy(registry, "/company", "/company")).toBe(false);
});

test("folderBusy: the COMPANY folder with a RUNNING session → busy", () => {
  const registry = createRegistry();
  const s = registry.add({ id: "c", source: "neo", folder: "/company", task: "", chatId: -1, createdAt: 0 }, 0);
  // registry.add() starts a session as "running" by default.
  expect(s.status).toBe("running");
  expect(folderBusy(registry, "/company", "/company")).toBe(true);
});

test("folderBusy: a NON-company folder with an IDLE session is STILL busy — presence semantics unchanged for every other loop", () => {
  const registry = createRegistry();
  const s = registry.add({ id: "p", source: "neo", folder: "/home/acme", task: "", chatId: 1, createdAt: 0 }, 0);
  registry.setStatus(s.id, "idle");
  expect(folderBusy(registry, "/home/acme", "/company")).toBe(true);
});

// --- Daemon-level wiring: resolve the loop's folder BEFORE the busy check ------------------------
// The bug: the scheduler tick used to check `isFolderBusy(def.folder)` against the memory-dream
// loop's UNRESOLVED "company" sentinel (never the real company folder), so it could never observe
// the company session as busy — risking a concurrent dream run against a live operator session in
// the same folder. The fix resolves every loop (resolveDreamLoop) before scheduling, so this test
// exercises the exact pairing daemon.ts now wires: resolved loops + folderBusy.

function fakeNeoConfig(companyFolder: string): NeoConfig {
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
    companyFolder,
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
    workers: { company: {}, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: {}, handoff: {} },
    workerEnv: {},
    memory: { scopes: ["company"], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 },
  };
}

test("scheduler wiring: memory-dream fires against an IDLE company session, but is skipped while it's RUNNING", () => {
  const companyFolder = "/tmp/neo-fake-company";
  const cfg = fakeNeoConfig(companyFolder);
  const registry = createRegistry();
  // The built-in's real trigger is a once-nightly cron ("0 3 * * *"), which would make this test's
  // due-ness depend on wall-clock alignment — irrelevant to what's under test here (folder
  // resolution + the busy guard), so it's swapped for a plain interval trigger; dreamMemory/folder
  // resolution (the thing this test actually exercises) is untouched.
  const dreamLoop = { ...resolveDreamLoop(matchLoop("memory-dream")!, cfg), trigger: { kind: "interval" as const, everyMs: 1_000 } };
  expect(dreamLoop.folder).toBe(companyFolder); // sentinel resolved to the real folder

  // The always-on company session, IDLE (registerDefaultProject's steady state).
  const session = registry.add({ id: "company", source: "neo", folder: companyFolder, task: "", chatId: -1, createdAt: 0 }, 0);
  registry.setStatus(session.id, "idle");

  let started: string[] = [];
  tickScheduler({
    loops: [dreamLoop],
    store: memStore({ "memory-dream": { enabled: true } }),
    isFolderBusy: (folder) => folderBusy(registry, folder, cfg.companyFolder),
    throttled: () => false,
    now: 10_000,
    start: (d) => started.push(d.name),
  });
  expect(started).toEqual(["memory-dream"]); // idle company → not busy → fires

  // Now the company session is mid-turn (a live operator conversation).
  registry.setStatus(session.id, "running");
  started = [];
  tickScheduler({
    loops: [dreamLoop],
    store: memStore({ "memory-dream": { enabled: true } }), // fresh store — lastRun would otherwise block re-fire
    isFolderBusy: (folder) => folderBusy(registry, folder, cfg.companyFolder),
    throttled: () => false,
    now: 20_000,
    start: (d) => started.push(d.name),
  });
  expect(started).toEqual([]); // running company → busy → skipped
});
