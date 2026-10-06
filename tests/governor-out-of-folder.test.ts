// `governor.outOfFolderWrites` (ADR-0012): the operator's standing approval for file writes outside
// the session's project folder. "allow" = no escalation; "ask" (and anything unset or unknown) = the
// fence escalation of ADR-0011. Customer-sourced work and ingress always keep the fence, and a
// tainted brief still runs with zero tools.
import { test, expect } from "bun:test";
import { decide } from "../src/engine/governor";
import { buildCanUseTool, buildGovernorHook, runConfig, runOrder, type RunHandlers } from "../src/engine/session-runner";
import type { Order } from "../src/types";
import { profileDeps } from "../src/engine/worker-profile";
import { TAINTED_DISALLOWED_TOOLS } from "../src/engine/ingress";
import { loadConfig } from "../src/config";
import type { NeoConfig } from "../src/config";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FOLDER = "/home/proj";
const OUT = { file_path: "/tmp/neo-perf/measure.cjs", content: "x" };

test("allow: Write/Edit/NotebookEdit outside the folder are allowed without an escalation", () => {
  const ctx = { folder: FOLDER, outOfFolderWrites: "allow" as const };
  expect(decide("Write", OUT, ctx)).toEqual({ allow: true });
  expect(decide("Edit", { file_path: "/root/.claude/projects/-home-gold/memory/x.md" }, ctx)).toEqual({ allow: true });
  expect(decide("NotebookEdit", { notebook_path: "/srv/n.ipynb" }, ctx)).toEqual({ allow: true });
});

test("ask: an out-of-folder write is still a fence escalation", () => {
  const v = decide("Write", OUT, { folder: FOLDER, outOfFolderWrites: "ask" });
  expect(v).toMatchObject({ fenced: true });
  expect("escalate" in v).toBe(true);
});

test("unset or unknown knob fails closed to ask", () => {
  expect("escalate" in decide("Write", OUT, { folder: FOLDER })).toBe(true);
  expect("escalate" in decide("Write", OUT, { folder: FOLDER, outOfFolderWrites: "yes" as never })).toBe(true);
});

test("allow never allows a write with no path", () => {
  expect("escalate" in decide("Write", {}, { folder: FOLDER, outOfFolderWrites: "allow" })).toBe(true);
});

test("allow changes nothing else: risky Bash, WebFetch, foreign MCP and unknown tools still escalate", () => {
  const ctx = { folder: FOLDER, outOfFolderWrites: "allow" as const };
  expect("escalate" in decide("Bash", { command: "git push origin main" }, ctx)).toBe(true);
  expect("escalate" in decide("Bash", { command: "rm -rf /tmp/x" }, ctx)).toBe(true);
  expect("escalate" in decide("WebFetch", { url: "https://x" }, ctx)).toBe(true);
  expect("escalate" in decide("mcp__foreign__thing", {}, ctx)).toBe(true);
  expect("escalate" in decide("SomeFutureTool", {}, ctx)).toBe(true);
});

function handlers(over: Partial<RunHandlers> = {}): RunHandlers {
  return { onMessage: () => {}, onEscalation: async () => "deny", ...over };
}

test("canUseTool: own work with allow never reaches the operator", async () => {
  let asked = 0;
  const canUse = buildCanUseTool(handlers({ onEscalation: async () => (asked++, "deny") }), FOLDER, "neo", "allow");
  expect((await canUse("Write", OUT)).behavior).toBe("allow");
  expect(asked).toBe(0);
});

test("canUseTool: customer-sourced work keeps the fence even when the knob says allow", async () => {
  let asked = 0;
  const canUse = buildCanUseTool(handlers({ onEscalation: async () => (asked++, "deny") }), FOLDER, "customer", "allow");
  expect((await canUse("Write", OUT)).behavior).toBe("deny");
  expect(asked).toBe(1);
});

test("canUseTool: default (no knob) still escalates", async () => {
  let asked = 0;
  const canUse = buildCanUseTool(handlers({ onEscalation: async () => (asked++, "allow") }), FOLDER, "neo");
  expect((await canUse("Write", OUT)).behavior).toBe("allow");
  expect(asked).toBe(1);
});

test("PreToolUse hook: allow gives no opinion; ask forces canUseTool", async () => {
  const pre = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: OUT, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: FOLDER };
  const sig = { signal: new AbortController().signal };
  expect(await buildGovernorHook(FOLDER, "allow")(pre as never, "t", sig)).toEqual({});
  const asked = (await buildGovernorHook(FOLDER, "ask")(pre as never, "t", sig)) as { hookSpecificOutput?: { permissionDecision?: string } };
  expect(asked.hookSpecificOutput?.permissionDecision).toBe("ask");
});

const CFG = {
  workers: {} as NeoConfig["workers"],
  workerEnv: {},
  governor: { outOfFolderWrites: "allow" as const, approvalRemindMs: 1, approvalTimeoutMs: 1 },
};

test("profileDeps threads the knob to own-work paths, never to ingress", () => {
  expect(profileDeps(CFG, "dispatch").outOfFolderWrites).toBe("allow");
  expect(profileDeps(CFG, "loop").outOfFolderWrites).toBe("allow");
  expect(profileDeps(CFG, "project").outOfFolderWrites).toBe("allow");
  expect(profileDeps(CFG, "ingress").outOfFolderWrites).toBeUndefined();
});

test("the knob is engine-side only: it never reaches the SDK run config", () => {
  expect(runConfig(profileDeps(CFG, "dispatch"))).not.toHaveProperty("outOfFolderWrites");
});

test("a tainted brief still has ZERO tools: every write tool is stripped regardless of the knob", () => {
  const d = profileDeps(CFG, "ingress", { disallowedTools: TAINTED_DISALLOWED_TOOLS });
  for (const t of ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch"]) expect(d.disallowedTools).toContain(t);
  expect(d.mcpServers).toBeUndefined();
});

test("config default is the operator's standing order: allow, with approval reminders and a timeout", () => {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), "neo-cfg-")));
  expect(cfg.governor?.outOfFolderWrites).toBe("allow");
  expect(cfg.governor?.approvalRemindMs).toBeGreaterThan(0);
  expect(cfg.governor?.approvalTimeoutMs).toBeGreaterThan(0);
});

test("config.json can turn the fence back on; the other governor keys keep their defaults", () => {
  const d = mkdtempSync(join(tmpdir(), "neo-cfg-"));
  writeFileSync(join(d, "config.json"), JSON.stringify({ governor: { outOfFolderWrites: "ask" } }));
  const cfg = loadConfig(d);
  expect(cfg.governor?.outOfFolderWrites).toBe("ask");
  expect(cfg.governor?.approvalTimeoutMs).toBeGreaterThan(0);
});

// End to end through sdkOptions: both governor seams (hook + canUseTool) get the run's knob, and a
// customer-sourced order is forced back to the fence on both.
async function optionsFor(source: Order["source"]) {
  let seen: any;
  const q = (args: { options: any }) => {
    seen = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  };
  const order: Order = { id: "o", source, folder: FOLDER, task: "t", chatId: 1, createdAt: 1 };
  await runOrder(order, handlers(), { query: q as never, outOfFolderWrites: "allow" });
  return seen;
}

const PRE = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: OUT, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: FOLDER };

test("runOrder: own work with allow — the hook has no opinion and canUseTool allows", async () => {
  const o = await optionsFor("neo");
  expect(await o.hooks.PreToolUse[0].hooks[0](PRE, "t", { signal: new AbortController().signal })).toEqual({});
  expect((await o.canUseTool("Write", OUT)).behavior).toBe("allow");
  expect(o).not.toHaveProperty("outOfFolderWrites");
});

test("runOrder: a customer order keeps the fence on both seams even with allow", async () => {
  const o = await optionsFor("customer");
  const hook = await o.hooks.PreToolUse[0].hooks[0](PRE, "t", { signal: new AbortController().signal });
  expect(hook.hookSpecificOutput.permissionDecision).toBe("ask");
  expect((await o.canUseTool("Write", OUT)).behavior).toBe("deny");
});
