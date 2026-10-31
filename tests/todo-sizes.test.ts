// ADR-0072: a todo has a size — the ledger part (spec §11, AC 5).
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import type { SizeUp } from "../src/engine/order-size";

const base = { project: "p", folder: "/p", brief: "fix the picker", workClass: "interactive" as const, createdBy: "company" as const };

test("a todo with no size is big, set by nobody", () => {
  const l = openLedger(":memory:");
  const t = l.addTodo(base);
  expect(t.size).toBe("big");
  expect(t.sizeBy).toBeUndefined();
  expect(t.sizeUp).toBeUndefined();
});

test("addTodo stores the size and who set it", () => {
  const l = openLedger(":memory:");
  const t = l.addTodo({ ...base, size: "quick", sizeBy: "operator" });
  expect(l.todoById(t.id)).toMatchObject({ size: "quick", sizeBy: "operator" });
  expect(l.listTodos({ folder: "/p" })[0]).toMatchObject({ size: "quick", sizeBy: "operator" });
});

test("updateTodo patches the size and the size up (JSON round trip); null clears the size up", () => {
  const l = openLedger(":memory:");
  const t = l.addTodo({ ...base, size: "quick", sizeBy: "company" });
  const sizeUp: SizeUp = { from: "quick", to: "big", rule: "auth", path: "services/identity-service/auth/token.go", at: 1234 };
  l.updateTodo(t.id, { size: "big", sizeUp });
  expect(l.todoById(t.id)).toMatchObject({ size: "big", sizeBy: "company", sizeUp });
  const late: SizeUp = { from: "quick", to: "standard", rule: "files", value: 6, max: 5, late: true, at: 99 };
  l.updateTodo(t.id, { sizeUp: late });
  expect(l.todoById(t.id)!.sizeUp).toEqual(late);
  l.updateTodo(t.id, { sizeUp: null });
  expect(l.todoById(t.id)!.sizeUp).toBeUndefined();
});

test("a bad stored size reads as big; bad size_up JSON reads as none, never a throw", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-sizes-")), "ledger.db");
  const l = openLedger(path);
  const t = l.addTodo({ ...base, size: "quick" });
  const db = new Database(path); // a second connection writes what an old or broken build left
  db.run(`UPDATE project_todos SET size = 'huge', size_by = 'someone', size_up = '{not json' WHERE id = ?`, [t.id]);
  const row = l.todoById(t.id)!;
  expect(row.size).toBe("big");
  expect(row.sizeBy).toBeUndefined();
  expect(row.sizeUp).toBeUndefined();
  // Well-formed JSON that is not a size up reads as none too.
  db.run(`UPDATE project_todos SET size_up = '{"from":"tiny","to":"big","rule":"x","at":1}' WHERE id = ?`, [t.id]);
  expect(l.todoById(t.id)!.sizeUp).toBeUndefined();
});
