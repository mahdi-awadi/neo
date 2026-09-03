import { expect, test } from "bun:test";
import {
  surfaceFor,
  priorityBadge,
  priorityStyle,
  styleLine,
  accentPrefix,
  PRIORITY_STYLES,
  type Priority,
} from "../src/engine/priority";

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

// --- Feature 2: central priority style map ---

test("priorityStyle maps each attention priority to a distinct colored accent", () => {
  expect(priorityStyle("decision").accent).toBe("🔵");
  expect(priorityStyle("alert").accent).toBe("🔴");
  expect(priorityStyle("done").accent).toBe("🟢");
  // The three attention accents are distinct (a legible "color" per priority).
  const accents = [priorityStyle("decision").accent, priorityStyle("alert").accent, priorityStyle("done").accent];
  expect(new Set(accents).size).toBe(3);
});

test("progress is the silent default — no accent (keeps the streamed firehose clean)", () => {
  expect(priorityStyle("progress").accent).toBe("");
  expect(accentPrefix("progress")).toBe("");
  expect(accentPrefix(undefined)).toBe("");
  expect(styleLine("worker output line", "progress")).toBe("worker output line");
  expect(styleLine("worker output line", undefined)).toBe("worker output line");
});

test("styleLine prepends exactly one accent for attention priorities", () => {
  expect(styleLine("failed to deploy", "alert")).toBe("🔴 failed to deploy");
  expect(styleLine("all green", "done")).toBe("🟢 all green");
  // one accent per line — styling an already-styled line does not stack accents
  expect(styleLine(styleLine("all green", "done"), "done")).toBe("🟢 all green");
});

test("accentPrefix carries a trailing space so it composes with the #project tag", () => {
  expect(accentPrefix("done")).toBe("🟢 ");
  expect(accentPrefix("alert")).toBe("🔴 ");
});

test("PRIORITY_STYLES is data-driven and total over Priority (one entry per priority)", () => {
  const all: Priority[] = ["decision", "alert", "progress", "done"];
  for (const p of all) expect(PRIORITY_STYLES[p]).toBeDefined();
});

test("priorityBadge derives from the central style map", () => {
  // decision/alert/done are non-empty badges; progress stays blank (silent default).
  expect(priorityBadge("decision")).toContain(priorityStyle("decision").accent);
  expect(priorityBadge("decision")).toContain("DECISION");
  expect(priorityBadge("progress")).toBe("");
});
