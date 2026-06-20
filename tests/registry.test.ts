import { test, expect } from "bun:test";
import { createRegistry } from "../src/engine/registry";
import type { Order } from "../src/types";

function order(over: Partial<Order> = {}): Order {
  return {
    id: over.id ?? crypto.randomUUID(),
    source: over.source ?? "neo",
    folder: over.folder ?? "/home/neo/projects/alpha",
    task: over.task ?? "do it",
    chatId: over.chatId ?? 100,
    createdAt: over.createdAt ?? 1,
  };
}

test("add registers a session addressable by id, name, and chat", () => {
  const reg = createRegistry();
  const o = order({ folder: "/home/neo/projects/alpha", chatId: 100 });
  const s = reg.add(o, 1000);
  expect(s.id).toBe(o.id);
  expect(s.name).toBe("alpha");
  expect(s.sdkSessionId).toBe("");
  expect(s.status).toBe("running");
  expect(s.startedAt).toBe(1000);
  expect(s.lastActivityAt).toBe(1000);
  expect(reg.get(o.id)).toEqual(s);
  expect(reg.findByChat(100)).toEqual(s);
  expect(reg.findByName("alpha")).toEqual(s);
});

test("tracks a default (fallback) session, gone once removed", () => {
  const reg = createRegistry();
  const s = reg.add(order({ folder: "/home/neo/agent", chatId: -1 }), 1);
  expect(reg.getDefault()).toBeUndefined();
  reg.setDefault(s.id);
  expect(reg.getDefault()?.id).toBe(s.id);
  reg.remove(s.id);
  expect(reg.getDefault()).toBeUndefined();
});

test("tracks two concurrent sessions independently", () => {
  const reg = createRegistry();
  const a = reg.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  const b = reg.add(order({ folder: "/p/beta", chatId: 2 }), 2);
  expect(reg.list().length).toBe(2);
  expect(reg.findByChat(1)?.id).toBe(a.id);
  expect(reg.findByChat(2)?.id).toBe(b.id);
});

test("uniquifies names when two sessions share a folder basename", () => {
  const reg = createRegistry();
  reg.add(order({ folder: "/x/proj", chatId: 1 }), 1);
  const second = reg.add(order({ folder: "/y/proj", chatId: 2 }), 2);
  expect(second.name).toBe("proj-2");
});

test("findByChat returns the most recent OPEN session and excludes closed ones", () => {
  const reg = createRegistry();
  const first = reg.add(order({ folder: "/p/a", chatId: 5 }), 1);
  const second = reg.add(order({ folder: "/p/b", chatId: 5 }), 2);
  expect(reg.findByChat(5)?.id).toBe(second.id); // most recently active
  reg.setStatus(second.id, "done");
  expect(reg.findByChat(5)?.id).toBe(first.id); // closed session excluded
});

test("setActive makes findByChat prefer the active session, falling back when it closes", () => {
  const reg = createRegistry();
  const a = reg.add(order({ folder: "/p/a", chatId: 5 }), 1);
  const b = reg.add(order({ folder: "/p/b", chatId: 5 }), 2);
  expect(reg.findByChat(5)?.id).toBe(b.id); // most recent by default
  reg.setActive(5, a.id);
  expect(reg.findByChat(5)?.id).toBe(a.id); // active wins
  reg.setStatus(a.id, "done");
  expect(reg.findByChat(5)?.id).toBe(b.id); // active closed -> fall back to most recent
});

test("attachControl stores a control handle retrievable by id and cleared on remove", () => {
  const reg = createRegistry();
  const o = order();
  reg.add(o, 1);
  const ctrl = { followUp: () => {}, interrupt: async () => {} };
  reg.attachControl(o.id, ctrl);
  expect(reg.getControl(o.id)).toBe(ctrl);
  reg.remove(o.id);
  expect(reg.getControl(o.id)).toBeUndefined();
});

test("touch, setStatus, setSdkSessionId, and remove mutate the entry", () => {
  const reg = createRegistry();
  const o = order();
  reg.add(o, 1);
  reg.touch(o.id, 50);
  reg.setStatus(o.id, "idle");
  reg.setSdkSessionId(o.id, "sdk-xyz");
  const s = reg.get(o.id)!;
  expect(s.lastActivityAt).toBe(50);
  expect(s.status).toBe("idle");
  expect(s.sdkSessionId).toBe("sdk-xyz");
  reg.remove(o.id);
  expect(reg.get(o.id)).toBeUndefined();
});
