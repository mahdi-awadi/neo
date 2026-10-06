import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dashboardSnapshot, listRepos } from "../src/engine/dashboard";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import type { Order } from "../src/types";

function order(over: Partial<Order> = {}): Order {
  return {
    id: over.id ?? crypto.randomUUID(),
    source: "neo",
    folder: over.folder ?? "/p/app",
    task: over.task ?? "do the thing",
    chatId: over.chatId ?? 0,
    createdAt: 1,
  };
}

test("listRepos finds git repos under a root", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-repos-"));
  mkdirSync(join(root, "alpha", ".git"), { recursive: true });
  mkdirSync(join(root, "beta", ".git"), { recursive: true });
  mkdirSync(join(root, "not-a-repo"), { recursive: true });
  const repos = listRepos(root);
  expect(repos).toContain(join(root, "alpha"));
  expect(repos).toContain(join(root, "beta"));
  expect(repos).not.toContain(join(root, "not-a-repo"));
});

test("dashboardSnapshot returns structured projects/usage/loops/recent", () => {
  const registry = createRegistry();
  const a = registry.add(order({ folder: "/p/alpha", task: "build x" }), 1000);
  registry.add(order({ folder: "/p/beta", task: "fix y" }), 2000);
  registry.setFocus(0, a.id, "once");

  const ledger = openLedger(":memory:");
  ledger.recordOrder(order({ id: "o1", folder: "/p/gamma", task: "old job" }));
  ledger.recordOutcome("o1", "done", "did it");

  const usage = { snapshot: () => ({ perWindow: {}, rateLimits: [], weeklyResetAt: null, turnCount: 3, contextOccupancy: 0, computedAt: 0 }) };

  const s = dashboardSnapshot({ registry, ledger, usage: usage as any, chatId: 0, now: 5000, reposRoot: "/nonexistent" });

  expect(s.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);
  const alpha = s.projects.find((p) => p.name === "alpha")!;
  expect(alpha.active).toBe(true);
  expect(alpha.folder).toBe("/p/alpha");
  expect(alpha.task).toBe("build x");
  expect(alpha.status).toBe("running");
  expect(alpha.ageMs).toBe(4000);
  expect(s.usage?.turnCount).toBe(3);
  expect(s.loops.find((l) => l.name === "green")).toBeTruthy();
  expect(s.recent[0]).toMatchObject({ folder: "/p/gamma", task: "old job", status: "done" });
});

test("dashboard rows expose activity + queued", () => {
  const registry = createRegistry();
  const s = registry.add(order({ id: "d1", folder: "/p", task: "t" }), 0);
  registry.setStatus(s.id, "running");
  registry.noteActivity(s.id, "Edit: web.ts", 5);
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 1 });
  const ledger = openLedger(":memory:");
  const rows = dashboardSnapshot({ registry, ledger, chatId: 0, now: 10_000 }).projects;
  expect(rows[0].activity).toEqual({ label: "Edit: web.ts", since: 5 });
  expect(rows[0].queued).toBe(1);
});

// 2026-07-23 review finding #4: the dashboard's ctxPct must be computed with the SAME
// windowTokensByModel override the keep/handoff/clear gates use — otherwise it can silently
// disagree with the gate's actual verdict.
test("dashboardSnapshot threads windowTokensByModel into the signals call, same as the gates", () => {
  const registry = createRegistry();
  const s = registry.add(order({ id: "d4", folder: "/p/gold", task: "t" }), 0);
  registry.setSdkSessionId(s.id, "sess-x");
  const ledger = openLedger(":memory:");
  let seenOpts: { windowTokensByModel?: Record<string, number> } | undefined;
  const rows = dashboardSnapshot({
    registry,
    ledger,
    chatId: 0,
    now: 10_000,
    windowTokensByModel: { "big-model": 1_000_000 },
    signals: (_folder, _id, opts) => {
      seenOpts = opts;
      return { occupancy: 0.42, turns: 3, ageMs: 0, idleMs: 0 };
    },
  }).projects;
  expect(rows.find((r) => r.id === "d4")!.ctxPct).toBe(42);
  expect(seenOpts?.windowTokensByModel).toEqual({ "big-model": 1_000_000 });
});

test("dashboard rows expose ctxPct via the default sessionContext (no signals injected)", () => {
  const registry = createRegistry();
  const withId = registry.add(order({ id: "d2", folder: "/p/no-transcript", task: "t" }), 0);
  registry.setSdkSessionId(withId.id, "sess-does-not-exist");
  const noId = registry.add(order({ id: "d3", folder: "/p/other", task: "t" }), 0);
  const ledger = openLedger(":memory:");
  const rows = dashboardSnapshot({ registry, ledger, chatId: 0, now: 10_000 }).projects;
  expect(rows.find((r) => r.id === "d2")!.ctxPct).toBe(0);
  expect(rows.find((r) => r.id === "d3")!.ctxPct).toBeUndefined();
});

// The console has to speak the same vocabulary as /list and `sessions` — a project shown as
// "running" while it sits between turns is the same lie on a third surface.
test("dashboardSnapshot carries the derived state and the one-line status per project", () => {
  const registry = createRegistry();
  const a = registry.add(order({ folder: "/p/alpha", task: "build x" }), 0);
  registry.attachControl(a.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => true });
  registry.noteActivity(a.id, "Bash: bun test", 0);
  const b = registry.add(order({ folder: "/p/beta", task: "fix y" }), 0);
  registry.attachControl(b.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false });

  const snap = dashboardSnapshot({ registry, ledger: openLedger(":memory:"), chatId: 0, now: 10_000, reposRoot: "/tmp" });
  const alpha = snap.projects.find((p) => p.name === "alpha")!;
  const beta = snap.projects.find((p) => p.name === "beta")!;
  expect(alpha.state).toBe("working");
  expect(alpha.line).toContain("Bash: bun test");
  expect(beta.state).toBe("idle");
  expect(beta.line).toContain("nothing in flight");
});

// ADR-0013: the console's ctx% must use the SDK-reported window the ledger holds, merged under the
// operator's override — the 235–306% the console showed was a 1M Opus session divided by 200k.
test("dashboardSnapshot measures with the SDK-reported windows from the ledger, override on top", () => {
  const registry = createRegistry();
  const s = registry.add(order({ id: "d5", folder: "/p/gold", task: "t" }), 0);
  registry.setSdkSessionId(s.id, "sess-y");
  const ledger = openLedger(":memory:");
  ledger.recordModelWindow("claude-opus-5-5", 1_000_000);
  let seen: Record<string, number> | undefined;
  dashboardSnapshot({
    registry,
    ledger,
    chatId: 0,
    now: 10_000,
    windowTokensByModel: { "big-model": 2_000_000 },
    signals: (_f, _id, opts) => {
      seen = opts?.windowTokensByModel;
      return { occupancy: 0.5, turns: 1, ageMs: 0, idleMs: 0 };
    },
  });
  expect(seen).toEqual({ "claude-opus-5-5": 1_000_000, "big-model": 2_000_000 });
});
