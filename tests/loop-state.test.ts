import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";

test("ledger persists loop last-run and enabled state independently", () => {
  const l = openLedger(":memory:");
  expect(l.getLastRun("docs-sweep")).toBeUndefined();
  expect(l.isEnabled("docs-sweep")).toBeUndefined();

  l.setLastRun("docs-sweep", 12345);
  expect(l.getLastRun("docs-sweep")).toBe(12345);

  l.setEnabled("docs-sweep", true);
  expect(l.isEnabled("docs-sweep")).toBe(true);
  expect(l.getLastRun("docs-sweep")).toBe(12345); // unchanged by the enabled write

  l.setEnabled("docs-sweep", false);
  expect(l.isEnabled("docs-sweep")).toBe(false);
});
