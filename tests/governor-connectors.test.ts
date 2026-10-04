import { test, expect } from "bun:test";
import { decide, isReadToolName, normalizeConnectors, parseMcpTool } from "../src/engine/governor";

const folder = "/p";

test("parseMcpTool splits mcp__<server>__<tool>, keeping underscores in the tool name", () => {
  expect(parseMcpTool("mcp__github__list_issues")).toEqual({ server: "github", tool: "list_issues" });
  expect(parseMcpTool("mcp__claude_ai_Gmail__send__draft")).toEqual({ server: "claude_ai_Gmail", tool: "send__draft" });
  expect(parseMcpTool("Bash")).toBeUndefined();
  expect(parseMcpTool("mcp__noseparator")).toBeUndefined();
});

test("isReadToolName recognises read verbs deterministically (snake, kebab, camel)", () => {
  for (const t of ["list_issues", "get_file_contents", "search-code", "searchMessages", "read", "query_db", "fetch_page"]) {
    expect(isReadToolName(t)).toBe(true);
  }
  for (const t of ["send_email", "create_issue", "delete_file", "merge_pull_request", "update", "post-message", "getaway"]) {
    expect(isReadToolName(t)).toBe(false);
  }
});

test("unlisted connectors keep today's behaviour: escalate", () => {
  const v = decide("mcp__gmail__list_messages", {}, { folder, connectors: { github: "send" } });
  expect("escalate" in v).toBe(true);
});

test("deny blocks every tool on the connector", () => {
  const v = decide("mcp__gmail__list_messages", {}, { folder, connectors: { gmail: "deny" } });
  expect("deny" in v).toBe(true);
});

test("read lets read tools flow and escalates outbound actions", () => {
  const ctx = { folder, connectors: { gmail: "read" as const } };
  expect(decide("mcp__gmail__search_threads", {}, ctx)).toEqual({ allow: true });
  const send = decide("mcp__gmail__send_message", {}, ctx);
  expect("escalate" in send && send.escalate).toContain("read-only connector gmail");
});

test("send allows every tool on the connector", () => {
  expect(decide("mcp__slack__post_message", {}, { folder, connectors: { slack: "send" } })).toEqual({ allow: true });
});

test("per-tool rules override the connector's access level", () => {
  const ctx = {
    folder,
    connectors: { github: { access: "read" as const, tools: { create_issue: "allow" as const, list_secrets: "deny" as const, merge_pull_request: "ask" as const } } },
  };
  expect(decide("mcp__github__create_issue", {}, ctx)).toEqual({ allow: true });
  expect("deny" in decide("mcp__github__list_secrets", {}, ctx)).toBe(true);
  expect("escalate" in decide("mcp__github__merge_pull_request", {}, ctx)).toBe(true);
  expect(decide("mcp__github__list_issues", {}, ctx)).toEqual({ allow: true });
  expect("escalate" in decide("mcp__github__push_files", {}, ctx)).toBe(true);
});

test("an object policy without access falls back to escalate for unlisted tools", () => {
  const ctx = { folder, connectors: { github: { tools: { list_issues: "allow" as const } } } };
  expect(decide("mcp__github__list_issues", {}, ctx)).toEqual({ allow: true });
  expect("escalate" in decide("mcp__github__get_me", {}, ctx)).toBe(true);
});

test("Neo's own tools stay allowed and cannot be narrowed or widened by connector config", () => {
  expect(decide("mcp__neo__dispatch", {}, { folder, connectors: { neo: "deny" } })).toEqual({ allow: true });
});

test("normalizeConnectors drops malformed entries so they fall back to escalate (fail closed)", () => {
  const out = normalizeConnectors({
    gmail: "read",
    slack: "write",
    github: { access: "send", tools: { delete_repo: "deny", weird: "yes" } },
    bad: 42,
    alsoBad: { access: "everything" },
  });
  expect(out).toEqual({
    gmail: "read",
    github: { access: "send", tools: { delete_repo: "deny" } },
  });
  expect(normalizeConnectors(undefined)).toEqual({});
  expect(normalizeConnectors([1, 2])).toEqual({});
});

test("loadConfig reads connectors from config.json and defaults to none", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { loadConfig } = await import("../src/config");
  const empty = mkdtempSync(join(tmpdir(), "neo-cfg-"));
  expect(loadConfig(empty).connectors).toEqual({});
  const d = mkdtempSync(join(tmpdir(), "neo-cfg-"));
  writeFileSync(join(d, "config.json"), JSON.stringify({ connectors: { gmail: "read", junk: "maybe" } }));
  expect(loadConfig(d).connectors).toEqual({ gmail: "read" });
});

test("profileDeps threads connector scopes into every launch path", async () => {
  const { profileDeps } = await import("../src/engine/worker-profile");
  const cfg = { workers: {} as never, workerEnv: {}, connectors: { gmail: "read" as const } };
  expect(profileDeps(cfg, "project").connectors).toEqual({ gmail: "read" });
  expect(profileDeps({ workers: {} as never, workerEnv: {} }, "project").connectors).toBeUndefined();
});

test("the Claude canUseTool bridge applies connector scopes without asking", async () => {
  const { buildCanUseTool } = await import("../src/engine/session-runner");
  let asked = 0;
  const can = buildCanUseTool(
    { onMessage: () => {}, onEscalation: async () => { asked++; return "deny"; } },
    "/p",
    { gmail: "read" },
  );
  expect(await can("mcp__gmail__list_threads", { q: "x" })).toEqual({ behavior: "allow", updatedInput: { q: "x" } });
  expect(asked).toBe(0);
  expect((await can("mcp__gmail__send_message", {})).behavior).toBe("deny");
  expect(asked).toBe(1);
});
