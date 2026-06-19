import { test, expect } from "bun:test";
import { decide } from "../src/engine/governor";

test("governor auto-allows safe read-only tools", () => {
  expect(decide("Read", { file_path: "/x" })).toEqual({ allow: true });
  expect(decide("Glob", { pattern: "**/*" })).toEqual({ allow: true });
  expect(decide("Grep", { pattern: "foo" })).toEqual({ allow: true });
});

test("governor allows in-folder file edits", () => {
  expect(decide("Write", { file_path: "/p/a.ts", content: "x" })).toEqual({ allow: true });
  expect(decide("Edit", { file_path: "/p/a.ts" })).toEqual({ allow: true });
});

test("governor allows non-risky bash", () => {
  expect(decide("Bash", { command: "bun test" })).toEqual({ allow: true });
});

test("governor escalates risky bash (rm)", () => {
  expect("escalate" in decide("Bash", { command: "rm -rf build" })).toBe(true);
});

test("governor escalates git push", () => {
  expect("escalate" in decide("Bash", { command: "git push origin main" })).toBe(true);
});

test("governor escalates network calls (curl)", () => {
  expect("escalate" in decide("Bash", { command: "curl https://evil.example" })).toBe(true);
});
