// ADR-0057: side lanes — the lane model, its config and how the ledger and registry hold it.
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LANES_CFG, LANE_KINDS, isLaneKind, readLanesCfg } from "../src/engine/lanes";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import type { Order } from "../src/types";

test("lane kinds are the four the spec names", () => {
  expect([...LANE_KINDS]).toEqual(["read-only", "ops", "test", "code"]);
  expect(isLaneKind("ops")).toBe(true);
  expect(isLaneKind("deploy")).toBe(false);
});

test("readLanesCfg: defaults, and a bad value keeps its default", () => {
  expect(DEFAULT_LANES_CFG).toEqual({ enabled: true, maxSidePerProject: 1, maxDispatchesHost: 3, worktreeRoot: join(tmpdir(), "neo-lanes"), noLaneClassifier: "none" });
  expect(readLanesCfg(undefined)).toEqual(DEFAULT_LANES_CFG);
  expect(readLanesCfg({ enabled: false, maxSidePerProject: 2, maxDispatchesHost: 5, worktreeRoot: "/var/tmp/lanes" })).toMatchObject({ enabled: false, maxSidePerProject: 2, maxDispatchesHost: 5, worktreeRoot: "/var/tmp/lanes" });
  expect(readLanesCfg({ enabled: "yes", maxSidePerProject: -1, maxDispatchesHost: 1.5, worktreeRoot: "relative/path", noLaneClassifier: "claude" })).toEqual(DEFAULT_LANES_CFG);
  expect(readLanesCfg({ maxSidePerProject: 0 }).maxSidePerProject).toBe(0); // 0 = no side lanes per project
});

test("a todo keeps its lane and kind; no lane = main", () => {
  const l = openLedger(":memory:");
  const main = l.addTodo({ project: "p", folder: "/p", brief: "build", workClass: "interactive", createdBy: "company" });
  const side = l.addTodo({ project: "p", folder: "/p", brief: "check docker", workClass: "interactive", createdBy: "company", lane: "side", laneKind: "ops" });
  expect(main).toMatchObject({ lane: "main" });
  expect(main.laneKind).toBeUndefined();
  expect(side).toMatchObject({ lane: "side", laneKind: "ops" });
  expect(l.listTodos({ folder: "/p", lane: "side" }).map((t) => t.id)).toEqual([side.id]);
  expect(l.listTodos({ folder: "/p", lane: "main" }).map((t) => t.id)).toEqual([main.id]);
  expect(l.listTodos({ folder: "/p" })).toHaveLength(2);
});

const order = (id: string, folder: string): Order => ({ id, source: "neo", folder, task: "t", chatId: 1, createdAt: 0 });

test("registry: findByFolder sees only the main lane; sideLanes lists a project's side lanes", () => {
  const r = createRegistry();
  const main = r.add(order("m", "/home/p"), 1);
  const side = r.add(order("s", "/home/p"), 2, { lane: { kind: "ops", projectFolder: "/home/p", todoId: 7 } });
  const code = r.add(order("c", "/tmp/neo-lanes/p-side-8"), 3, { lane: { kind: "code", projectFolder: "/home/p", todoId: 8 } });
  expect(r.findByFolder("/home/p")?.id).toBe(main.id); // the newer side session is never the main one
  expect(r.findByFolder("/tmp/neo-lanes/p-side-8")).toBeUndefined();
  expect(r.sideLanes("/home/p").map((s) => s.id).sort()).toEqual([code.id, side.id].sort());
  expect(side.name).toBe("p-side-ops");
  expect(code.name).toBe("p-side-code");
  expect(r.sideLanes().length).toBe(2);
  r.setStatus(side.id, "done");
  expect(r.sideLanes("/home/p").map((s) => s.id)).toEqual([code.id]); // only open ones
});
