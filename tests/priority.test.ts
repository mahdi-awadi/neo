import { expect, test } from "bun:test";
import { surfaceFor, priorityBadge, type Priority } from "../src/engine/priority";

test("decision and alert route to the decisions surface", () => {
  expect(surfaceFor("decision")).toBe("decisions");
  expect(surfaceFor("alert")).toBe("decisions");
});

test("progress and done route to the firehose", () => {
  expect(surfaceFor("progress")).toBe("firehose");
  expect(surfaceFor("done")).toBe("firehose");
});

test("badge is a short non-empty marker per attention priority; progress is blank", () => {
  for (const p of ["decision", "alert", "done"] as const) {
    expect(priorityBadge(p).length).toBeGreaterThan(0);
  }
  // progress is the silent default — no badge chrome.
  expect(priorityBadge("progress")).toBe("");
});

test("surfaceFor accepts every Priority (exhaustive)", () => {
  const all: Priority[] = ["decision", "alert", "progress", "done"];
  for (const p of all) expect(["decisions", "firehose"]).toContain(surfaceFor(p));
});
