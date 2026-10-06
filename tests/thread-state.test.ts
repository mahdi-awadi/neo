import { test, expect } from "bun:test";
import { deriveThreadState } from "../src/engine/thread-state";

const base = { openDecisions: 0, pendingApprovals: 0, activeWork: 0, closedByOperator: false };

test("deriveThreadState follows the spec §5 table", () => {
  const rows: Array<[string, Partial<Parameters<typeof deriveThreadState>[0]>, string]> = [
    ["operator closed it", { closedByOperator: true }, "done"],
    ["an open decision", { openDecisions: 1 }, "waiting"],
    ["a pending approval", { pendingApprovals: 1 }, "waiting"],
    ["active work", { activeWork: 2 }, "open"],
    ["no work, newest end failed", { lastEnd: "failed" }, "failed"],
    ["no work, newest end ok", { lastEnd: "ok" }, "done"],
    ["no work ever (a pure chat answer)", {}, "done"],
  ];
  for (const [name, over, want] of rows) expect(deriveThreadState({ ...base, ...over }), name).toBe(want as never);
});

test("waiting on the operator beats open work, and closed by operator beats everything", () => {
  expect(deriveThreadState({ ...base, openDecisions: 1, activeWork: 3 })).toBe("waiting");
  expect(deriveThreadState({ ...base, pendingApprovals: 1, activeWork: 1, lastEnd: "failed" })).toBe("waiting");
  expect(deriveThreadState({ ...base, closedByOperator: true, openDecisions: 1, activeWork: 1, lastEnd: "failed" })).toBe("done");
});

test("active work beats an old failure", () => {
  expect(deriveThreadState({ ...base, activeWork: 1, lastEnd: "failed" })).toBe("open");
});
