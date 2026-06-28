import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";

test("ledger stores, lists, and deletes loop defs", () => {
  const l = openLedger(":memory:");
  expect(l.listLoopDefs()).toEqual([]);
  l.saveLoopDef("nightly-fmt", '{"name":"nightly-fmt"}');
  l.saveLoopDef("tidy", '{"name":"tidy"}');
  const names = l.listLoopDefs().map((r) => r.name).sort();
  expect(names).toEqual(["nightly-fmt", "tidy"]);
  l.deleteLoopDef("tidy");
  expect(l.listLoopDefs().map((r) => r.name)).toEqual(["nightly-fmt"]);
});

test("saveLoopDef upserts by name", () => {
  const l = openLedger(":memory:");
  l.saveLoopDef("x", '{"v":1}');
  l.saveLoopDef("x", '{"v":2}');
  expect(l.listLoopDefs()).toEqual([{ name: "x", json: '{"v":2}' }]);
});

test("deleteLoopDef also clears the loop_state row", () => {
  const l = openLedger(":memory:");
  l.saveLoopDef("x", "{}");
  l.setEnabled("x", true);
  l.setLastRun("x", 123);
  l.deleteLoopDef("x");
  expect(l.isEnabled("x")).toBeUndefined();
  expect(l.getLastRun("x")).toBeUndefined();
});
