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
  expect(reg.findByName("alpha")).toEqual(s);
  // A freshly-added project is NOT addressable by chat until it's explicitly focused (default = company).
  expect(reg.findByChat(100)).toBeUndefined();
  reg.setFocus(100, o.id, "once");
  expect(reg.findByChat(100)).toEqual(s);
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
  reg.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  reg.add(order({ folder: "/p/beta", chatId: 2 }), 2);
  expect(reg.list().length).toBe(2);
});

test("uniquifies names when two sessions share a folder basename", () => {
  const reg = createRegistry();
  reg.add(order({ folder: "/x/proj", chatId: 1 }), 1);
  const second = reg.add(order({ folder: "/y/proj", chatId: 2 }), 2);
  expect(second.name).toBe("proj-2");
});

test("findByChat returns ONLY the focused session — no most-recent fallback (default = company)", () => {
  const reg = createRegistry();
  const a = reg.add(order({ folder: "/p/a", chatId: 5 }), 1);
  reg.add(order({ folder: "/p/b", chatId: 5 }), 2);
  // Nothing focused: findByChat is undefined so the pipeline falls back to the company/default.
  expect(reg.findByChat(5)).toBeUndefined();
  reg.setFocus(5, a.id, "pinned");
  expect(reg.findByChat(5)?.id).toBe(a.id);
});

test("getFocus carries the mode and drops when the focused session closes", () => {
  const reg = createRegistry();
  const a = reg.add(order({ folder: "/p/a", chatId: 5 }), 1);
  reg.setFocus(5, a.id, "once");
  expect(reg.getFocus(5)).toEqual({ session: reg.get(a.id)!, mode: "once" });
  reg.setStatus(a.id, "done"); // closed → focus no longer resolves
  expect(reg.getFocus(5)).toBeUndefined();
  expect(reg.findByChat(5)).toBeUndefined();
});

test("clearFocus reverts a chat to the default target", () => {
  const reg = createRegistry();
  const a = reg.add(order({ folder: "/p/a", chatId: 5 }), 1);
  reg.setFocus(5, a.id, "pinned");
  expect(reg.findByChat(5)?.id).toBe(a.id);
  reg.clearFocus(5);
  expect(reg.getFocus(5)).toBeUndefined();
  expect(reg.findByChat(5)).toBeUndefined();
});

test("focus is per-chat: focusing in one chat never leaks into another", () => {
  const reg = createRegistry();
  const a = reg.add(order({ folder: "/p/a", chatId: 5 }), 1);
  reg.setFocus(5, a.id, "once");
  expect(reg.getFocus(5)?.session.id).toBe(a.id);
  expect(reg.getFocus(7)).toBeUndefined();
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

test("attachControl after the session was removed does not leak a control (best-effort interrupts, doesn't store)", () => {
  const reg = createRegistry();
  const o = order();
  reg.add(o, 1);
  reg.remove(o.id); // e.g. /kill during a pending gate
  let interrupted = false;
  const ctrl = { followUp: () => {}, interrupt: async () => void (interrupted = true) };
  reg.attachControl(o.id, ctrl);
  expect(reg.getControl(o.id)).toBeUndefined();
  expect(interrupted).toBe(true);
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

test("noteActivity sets the label and keeps `since` while the label is unchanged", () => {
  const r = createRegistry();
  const s = r.add({ id: "a1", source: "neo", folder: "/p", task: "t", chatId: 1, createdAt: 0 }, 0);
  r.noteActivity(s.id, "Bash: bun test", 100);
  expect(r.get(s.id)?.activity).toEqual({ label: "Bash: bun test", since: 100 });
  r.noteActivity(s.id, "Bash: bun test", 500); // same label -> since unchanged (measures how long it's ground on it)
  expect(r.get(s.id)?.activity).toEqual({ label: "Bash: bun test", since: 100 });
  r.noteActivity(s.id, "replying", 900); // new label -> since resets
  expect(r.get(s.id)?.activity).toEqual({ label: "replying", since: 900 });
});

test("noteAlert stamps alertedAt", () => {
  const r = createRegistry();
  const s = r.add({ id: "a2", source: "neo", folder: "/p", task: "t", chatId: 1, createdAt: 0 }, 0);
  r.noteAlert(s.id, 42);
  expect(r.get(s.id)?.alertedAt).toBe(42);
});
