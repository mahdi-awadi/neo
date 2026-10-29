// ADR-0065: tapping a todo opens its detail — the plain summary, the full brief, project, lane, state,
// times, result or last note, links, and the actions the engine allows for its state.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { todoDetail } from "../src/engine/dashboard";

function setup() {
  const led = openLedger(":memory:");
  const add = (brief: string, over: Record<string, unknown> = {}) =>
    led.addTodo({ project: "gold", folder: "/home/gold", brief, workClass: "interactive", createdBy: "operator", ...over } as never, 100);
  return { led, add };
}

test("a queued todo: summary, full brief, project, lane, position and its allowed actions", () => {
  const { led, add } = setup();
  add("first task");
  const t = add("Operator order (2026-10-29): fix the wallet refund. Then write the tests.", { summary: "Fix the wallet refund" });
  const d = todoDetail(led, t.id, 200)!;
  expect(d).toMatchObject({
    id: t.id,
    project: "gold",
    title: "Fix the wallet refund",
    brief: "Operator order (2026-10-29): fix the wallet refund. Then write the tests.",
    lane: "main",
    status: "queued",
    position: 2,
    createdAt: 100,
    actions: ["up", "cancel"],
    pinned: false,
  });
});

test("a failed todo: its reason and result, retry allowed, and the attention items it was made from", () => {
  const { led, add } = setup();
  const t = add("deploy fix");
  led.updateTodo(t.id, { status: "failed", startedAt: 150, endedAt: 300, result: "tests failed: 3", failure: "stall" } as never);
  const att = led.insertAttention({ project: "gold", folder: "/home/gold", source: "git", kind: "unpushed", key: "dev", title: "dev: 3 unpushed", severity: "normal" }, 1);
  led.updateAttention(att, { todoId: t.id });
  led.setPin(`todo:${t.id}`, "pinned", 5);
  const d = todoDetail(led, t.id, 400)!;
  expect(d).toMatchObject({ status: "failed", startedAt: 150, endedAt: 300, result: "tests failed: 3", failure: "stall", actions: ["retry", "cancel"], pinned: true });
  expect(d.attention).toEqual([{ id: att, title: "dev: 3 unpushed" }]);
  expect(d.position).toBe(0);
});

test("a done todo has no actions; an unknown id is undefined; a huge brief and result are capped", () => {
  const { led, add } = setup();
  const t = add("x".repeat(20_000));
  led.updateTodo(t.id, { status: "done", endedAt: 300, result: "y".repeat(20_000) } as never);
  const d = todoDetail(led, t.id, 400)!;
  expect(d.actions).toEqual([]);
  expect(d.brief.length).toBeLessThanOrEqual(4000);
  expect(d.result!.length).toBeLessThanOrEqual(4000);
  expect(todoDetail(led, 9_999, 400)).toBeUndefined();
});
