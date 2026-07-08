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
  registry.setActive(0, a.id);

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
  expect(s.loops.find((l) => l.name === "gold-gofmt")).toBeTruthy();
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
