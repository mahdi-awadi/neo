// Graceful daemon reload: drain running sessions (wrap-up follow-up + bounded window),
// persist every open session's resume target, and re-register them on the next boot so a
// follow-up/dispatch resumes instead of starting cold.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLifecycle, drainAndPersist, restoreSessions, wrapUpFollowUp } from "../src/engine/reload";
import { createRegistry } from "../src/engine/registry";
import { openLedger, type OpenSessionRow } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { handleMessage, type PipelineDeps } from "../src/engine/pipeline";
import { dispatchToProject, type DispatchDeps } from "../src/engine/dispatch";
import { handleCommand } from "../src/engine/commands";
import { loadConfig } from "../src/config";
import type { Order, SessionControl } from "../src/types";

function order(folder: string, chatId = 7): Order {
  return { id: crypto.randomUUID(), source: "neo", folder, task: "work", chatId, createdAt: 1000 };
}

// --- ledger: open-session snapshot -------------------------------------------------------------

test("ledger saves and takes the open-session snapshot (take clears it)", () => {
  const ledger = openLedger(":memory:");
  const rows: OpenSessionRow[] = [
    { id: "a", name: "gold", folder: "/home/gold", chatId: 7, sdkSessionId: "sdk-1", task: "t", source: "neo", createdAt: 5 },
  ];
  ledger.saveOpenSessions(rows);
  expect(ledger.takeOpenSessions()).toEqual(rows);
  expect(ledger.takeOpenSessions()).toEqual([]); // consumed — a second boot restores nothing
});

test("saveOpenSessions replaces the previous snapshot wholesale", () => {
  const ledger = openLedger(":memory:");
  ledger.saveOpenSessions([{ id: "a", name: "a", folder: "/home/a", chatId: 1, sdkSessionId: "s1", task: "t", source: "neo", createdAt: 1 }]);
  ledger.saveOpenSessions([{ id: "b", name: "b", folder: "/home/b", chatId: 1, sdkSessionId: "s2", task: "t", source: "neo", createdAt: 2 }]);
  const rows = ledger.takeOpenSessions();
  expect(rows.length).toBe(1);
  expect(rows[0].id).toBe("b");
});

// --- lifecycle gate -----------------------------------------------------------------------------

test("lifecycle starts open and flips to draining once", () => {
  const l = createLifecycle();
  expect(l.draining()).toBe(false);
  l.beginDrain();
  expect(l.draining()).toBe(true);
});

test("pipeline refuses new messages while draining", async () => {
  const replies: string[] = [];
  const lifecycle = createLifecycle();
  lifecycle.beginDrain();
  const deps = {
    cfg: loadConfig(mkdtempSync(join(tmpdir(), "neo-cfg-"))),
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c: number, t: string) => void replies.push(t),
    askApproval: async () => "deny" as const,
    lifecycle,
  } satisfies PipelineDeps;
  const run = await handleMessage("do something", 7, deps);
  expect(run).toBeNull();
  expect(replies.join(" ")).toContain("reload");
});

test("dispatch refuses new sub-runs while draining", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-reload-"));
  mkdirSync(join(root, "gold"));
  const lifecycle = createLifecycle();
  lifecycle.beginDrain();
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: () => {},
    askApproval: async () => "deny",
    lifecycle,
  };
  const out = await dispatchToProject("gold", "task", d, 1, { root });
  expect(out).toContain("reload");
  expect(d.registry.list().length).toBe(0); // nothing registered/started
});

// --- drain --------------------------------------------------------------------------------------

test("drainAndPersist pushes a wrap-up follow-up and waits for running turns to finish", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add(order("/home/gold"));
  registry.setSdkSessionId(s.id, "sdk-gold");
  const followUps: string[] = [];
  let interrupted = false;
  const control: SessionControl = {
    followUp: (t) => {
      followUps.push(t);
      // the worker wraps up: turn ends, pipeline marks it idle
      registry.setStatus(s.id, "idle");
    },
    interrupt: async () => void (interrupted = true),
  };
  registry.attachControl(s.id, control);

  const lifecycle = createLifecycle();
  const res = await drainAndPersist({
    registry,
    ledger,
    lifecycle,
    drainMs: 90_000,
    pollMs: 1,
    sleep: async () => {},
  });
  expect(lifecycle.draining()).toBe(true);
  expect(followUps.length).toBe(1);
  expect(followUps[0].toLowerCase()).toContain("commit");
  expect(interrupted).toBe(false); // wrapped up inside the window — never hard-aborted
  expect(res.interrupted).toEqual([]);
  const rows = ledger.takeOpenSessions();
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ folder: "/home/gold", sdkSessionId: "sdk-gold" });
});

test("drainAndPersist interrupts a session that outlives the drain window", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add(order("/home/slow"));
  registry.setSdkSessionId(s.id, "sdk-slow");
  let interrupted = false;
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => void (interrupted = true) });

  let t = 0;
  const res = await drainAndPersist({
    registry,
    ledger,
    drainMs: 90_000,
    pollMs: 10_000,
    now: () => t,
    sleep: async (ms) => void (t += ms),
  });
  expect(interrupted).toBe(true);
  expect(res.interrupted).toEqual([s.id]);
  // still persisted — the resume target survives the hard abort
  expect(ledger.takeOpenSessions()[0]).toMatchObject({ folder: "/home/slow", sdkSessionId: "sdk-slow" });
});

test("drainAndPersist backfills a missing sdk id from the ledger's last session", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const o = order("/home/gold", 7);
  ledger.recordOrder(o);
  ledger.recordSession(o.id, "sdk-from-ledger");
  const s = registry.add(o);
  registry.setStatus(s.id, "idle"); // idle, no live sdk id on the entry
  await drainAndPersist({ registry, ledger, drainMs: 0, pollMs: 1, sleep: async () => {} });
  expect(ledger.takeOpenSessions()[0].sdkSessionId).toBe("sdk-from-ledger");
});

test("wrapUpFollowUp names the deadline", () => {
  expect(wrapUpFollowUp(90_000)).toContain("90s");
});

// --- boot-time restore --------------------------------------------------------------------------

test("restoreSessions re-registers persisted sessions as idle + resumable", () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  ledger.saveOpenSessions([
    { id: "a", name: "gold", folder: "/home/gold", chatId: 7, sdkSessionId: "sdk-1", task: "t", source: "neo", createdAt: 5 },
  ]);
  const restored = restoreSessions(registry, ledger, () => 999);
  expect(restored.length).toBe(1);
  const s = registry.findByFolder("/home/gold");
  expect(s).toBeDefined();
  expect(s!.status).toBe("idle");
  expect(s!.sdkSessionId).toBe("sdk-1");
  expect(s!.order.chatId).toBe(7);
  // consumed: a second restore is a no-op
  expect(restoreSessions(registry, ledger).length).toBe(0);
});

test("restoreSessions attaches the sdk id to an already-registered folder instead of duplicating", () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const company = registry.add(order("/home/neo/agent", -1));
  registry.setStatus(company.id, "idle");
  ledger.saveOpenSessions([
    { id: "x", name: "agent", folder: "/home/neo/agent", chatId: -1, sdkSessionId: "sdk-co", task: "t", source: "neo", createdAt: 5 },
  ]);
  const restored = restoreSessions(registry, ledger);
  expect(restored.length).toBe(0); // nothing new registered
  expect(registry.list().length).toBe(1);
  expect(registry.get(company.id)!.sdkSessionId).toBe("sdk-co");
});

test("restoreSessions falls back to lastSessionFor when the snapshot has no sdk id", () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const o = order("/home/gold", 7);
  ledger.recordOrder(o);
  ledger.recordSession(o.id, "sdk-prior");
  ledger.saveOpenSessions([
    { id: o.id, name: "gold", folder: "/home/gold", chatId: 7, sdkSessionId: "", task: "t", source: "neo", createdAt: 5 },
  ]);
  restoreSessions(registry, ledger);
  expect(registry.findByFolder("/home/gold")!.sdkSessionId).toBe("sdk-prior");
});

// --- /reload command ----------------------------------------------------------------------------

test("/reload triggers the injected reload and reports the drain", () => {
  let requested = false;
  const res = handleCommand("/reload", 7, {
    registry: createRegistry(),
    ledger: openLedger(":memory:"),
    trust: openTrustStore(":memory:"),
    requestReload: () => void (requested = true),
  });
  expect(res).not.toBeNull();
  expect(requested).toBe(true);
  expect(res!.text).toContain("reload");
});

test("/reload without a wired reloader says it is unavailable", () => {
  const res = handleCommand("/reload", 7, {
    registry: createRegistry(),
    ledger: openLedger(":memory:"),
    trust: openTrustStore(":memory:"),
  });
  expect(res!.text).toContain("unavailable");
});

// --- config -------------------------------------------------------------------------------------

test("config exposes drainWindowMs with a 90s default", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-cfg-"));
  expect(loadConfig(dir).drainWindowMs).toBe(90_000);
});
