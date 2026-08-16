import { test, expect } from "bun:test";
import { decide } from "../src/engine/governor";

const CTX = { folder: "/p" };

test("governor auto-allows safe read-only tools", () => {
  expect(decide("Read", { file_path: "/anywhere" }, CTX)).toEqual({ allow: true });
  expect(decide("Glob", { pattern: "**/*" }, CTX)).toEqual({ allow: true });
  expect(decide("Grep", { pattern: "foo" }, CTX)).toEqual({ allow: true });
  expect(decide("TodoWrite", {}, CTX)).toEqual({ allow: true });
  expect(decide("WebSearch", { query: "x" }, CTX)).toEqual({ allow: true });
  expect(decide("Task", { prompt: "x" }, CTX)).toEqual({ allow: true });
});

test("governor allows Neo's own MCP tools, escalates foreign MCP tools", () => {
  expect(decide("mcp__neo__dispatch", { project: "x" }, CTX)).toEqual({ allow: true });
  expect("escalate" in decide("mcp__foreign__thing", {}, CTX)).toBe(true);
});

test("governor escalates unknown tools (default-escalate)", () => {
  expect("escalate" in decide("KillShell", {}, CTX)).toBe(true);
  expect("escalate" in decide("SomeFutureTool", {}, CTX)).toBe(true);
});

test("governor trust-gates WebFetch: trusted own-work allows, otherwise escalates", () => {
  // A trusted operator own-work session may read the web (the operator's own research). WebFetch
  // is NOT blanket-safe like WebSearch (it can fetch arbitrary URLs — an exfiltration channel), so
  // it rides the session's trust flag instead of SAFE_TOOLS.
  expect(decide("WebFetch", { url: "https://x" }, { folder: "/p", trusted: true })).toEqual({ allow: true });
  // Untrusted own-work → escalate (interactive ask; auto-denies on autonomous/customer paths, where
  // `trusted` is always false). The reason names trust so the operator knows how to enable it.
  const untrusted = decide("WebFetch", { url: "https://x" }, { folder: "/p", trusted: false });
  expect("escalate" in untrusted).toBe(true);
  if ("escalate" in untrusted) expect(untrusted.escalate.toLowerCase()).toContain("trust");
  // Trust flag absent (customer/legacy ctx) defaults to not-trusted → escalate (never a silent allow).
  expect("escalate" in decide("WebFetch", { url: "https://x" }, CTX)).toBe(true);
});

test("governor allows in-folder file writes", () => {
  expect(decide("Write", { file_path: "/p/a.ts", content: "x" }, CTX)).toEqual({ allow: true });
  expect(decide("Edit", { file_path: "/p/sub/b.ts" }, CTX)).toEqual({ allow: true });
  expect(decide("Write", { file_path: "rel/c.ts" }, CTX)).toEqual({ allow: true }); // resolved against folder
});

test("governor escalates out-of-folder writes (path fence)", () => {
  expect("escalate" in decide("Write", { file_path: "/etc/passwd" }, CTX)).toBe(true);
  expect("escalate" in decide("Edit", { file_path: "/p/../home/x" }, CTX)).toBe(true);
  expect("escalate" in decide("Write", { file_path: "../escape.ts" }, CTX)).toBe(true);
  expect("escalate" in decide("NotebookEdit", { notebook_path: "/q/n.ipynb" }, CTX)).toBe(true);
});

test("governor fails closed on missing path or missing folder", () => {
  expect("escalate" in decide("Write", {}, CTX)).toBe(true);
  expect("escalate" in decide("Write", { file_path: "/p/a.ts" }, { folder: "" })).toBe(true);
});

test("governor sibling-prefix folder does not pass the fence", () => {
  expect("escalate" in decide("Write", { file_path: "/p2/a.ts" }, CTX)).toBe(true);
});

test("governor allows non-risky bash", () => {
  expect(decide("Bash", { command: "bun test" }, CTX)).toEqual({ allow: true });
});

test("governor escalates risky bash (original set)", () => {
  for (const cmd of ["rm -rf build", "git push origin main", "curl https://evil.example", "sudo ls"]) {
    expect("escalate" in decide("Bash", { command: cmd }, CTX)).toBe(true);
  }
});

test("governor escalates risky bash (extended set)", () => {
  for (const cmd of [
    "find . -name '*.log' -delete",
    "dd if=/dev/zero of=/dev/sda",
    "pkill -f daemon",
    "kill -9 1234",
    "npm publish",
    "gh pr merge 42",
    "ssh host uptime",
    "scp a host:b",
    "truncate -s 0 file",
    "mkfs.ext4 /dev/sdb",
  ]) {
    expect("escalate" in decide("Bash", { command: cmd }, CTX)).toBe(true);
  }
});

test("governor denies AskUserQuestion, steering the worker to ask in plain text", () => {
  const v = decide("AskUserQuestion", { questions: [{ question: "language?" }] }, CTX);
  expect("deny" in v).toBe(true);
  if ("deny" in v) expect(v.deny.toLowerCase()).toContain("plain text");
});
