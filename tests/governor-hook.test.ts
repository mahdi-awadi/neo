// The governor's PreToolUse hook: closes the settings-allow-rule bypass. Allow rules in a project's
// `.claude/settings.json` approve a tool BEFORE `canUseTool` runs (proven live 2026-10-01,
// spike/governor-bypass-probe.ts), so the governor must also run as a hook, which the SDK consults
// first. The hook never resolves an escalation itself: every non-allow verdict becomes "ask", which
// forces the call into canUseTool (verified live: a hook "ask" reaches canUseTool even when an allow
// rule matches). A throwing hook FAILS OPEN in the SDK (verified live), so the hook must never throw.
import { test, expect } from "bun:test";
import { buildGovernorHook, runOrder, startOrder } from "../src/engine/session-runner";
import type { Order } from "../src/types";

const FOLDER = "/home/proj";

function pre(tool_name: string, tool_input: unknown) {
  return {
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    tool_use_id: "t1",
    session_id: "s",
    transcript_path: "",
    cwd: FOLDER,
  };
}

async function decisionOf(tool: string, input: unknown): Promise<string | undefined> {
  const hook = buildGovernorHook(FOLDER);
  const out = (await hook(pre(tool, input) as never, "t1", { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
  };
  if (out.hookSpecificOutput) expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  return out.hookSpecificOutput?.permissionDecision;
}

test("an escalated Bash command is forced to canUseTool ('ask'), so a settings allow rule cannot approve it", async () => {
  expect(await decisionOf("Bash", { command: "git push --force origin main" })).toBe("ask");
});

test("an out-of-folder write is forced to canUseTool (the path fence holds against allow rules)", async () => {
  expect(await decisionOf("Write", { file_path: "/etc/passwd", content: "x" })).toBe("ask");
});

test("an unknown tool and WebFetch are forced to canUseTool (default-escalate holds)", async () => {
  expect(await decisionOf("WebFetch", { url: "https://example.com" })).toBe("ask");
  expect(await decisionOf("mcp__foreign__do", {})).toBe("ask");
});

test("a deny verdict also routes to canUseTool, which owns the AskUserQuestion structured-question path", async () => {
  expect(await decisionOf("AskUserQuestion", { questions: [] })).toBe("ask");
});

test("a governor-allowed tool gets no hook opinion, so settings deny rules and canUseTool still apply", async () => {
  expect(await decisionOf("Bash", { command: "git status" })).toBeUndefined();
  expect(await decisionOf("Write", { file_path: `${FOLDER}/a.ts`, content: "x" })).toBeUndefined();
  expect(await decisionOf("Read", { file_path: "/etc/hosts" })).toBeUndefined();
});

test("malformed input never throws (a throwing hook fails open) — it fails closed to 'ask'", async () => {
  expect(await decisionOf("Bash", null)).toBe("ask");
  expect(await decisionOf("Write", undefined)).toBe("ask");
});

test("a non-PreToolUse event gets no opinion", async () => {
  const hook = buildGovernorHook(FOLDER);
  const out = await hook({ hook_event_name: "PostToolUse" } as never, undefined, { signal: new AbortController().signal });
  expect(out).toEqual({});
});

// --- Wiring: every Claude launch goes through sdkOptions; assert the hook + default mode on both
// entry points and on the dispatch / judge / team / loop option shapes. ---

function order(folder = FOLDER): Order {
  return { id: "o1", source: "neo", folder, task: "do it", chatId: 1, createdAt: 1 };
}

function captureRun() {
  let seen: any;
  const q = (args: { prompt: unknown; options: any }) => {
    seen = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  };
  return { q, seen: () => seen };
}

async function expectGoverned(options: any) {
  expect(options.permissionMode).toBe("default");
  expect(typeof options.canUseTool).toBe("function");
  const matchers = options.hooks?.PreToolUse;
  expect(Array.isArray(matchers)).toBe(true);
  expect(matchers).toHaveLength(1);
  // No matcher filter: the hook must see EVERY tool (incl. subagent and MCP tools).
  expect(matchers[0].matcher).toBeUndefined();
  const out = await matchers[0].hooks[0](pre("Bash", { command: "rm -rf /" }), "t1", {
    signal: new AbortController().signal,
  });
  expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
}

const handlers = { onMessage: () => {}, onEscalation: async () => "deny" as const };

const SHAPES: Array<[string, Record<string, unknown>]> = [
  ["plain", {}],
  ["dispatch (mcpServers + model + env)", { mcpServers: { neo: {} }, model: "opus", env: { X: "1" } }],
  ["judge (read-only deny-list)", { disallowedTools: ["Write", "Edit", "Bash"], maxTurns: 3 }],
  ["team (agents)", { agents: { frontend: { description: "fe", prompt: "p" } } }],
  ["loop (resume + effort)", { resume: "r1", effort: "low" }],
];

for (const [name, deps] of SHAPES) {
  test(`runOrder (${name}) is governed by the PreToolUse hook in permissionMode "default"`, async () => {
    const c = captureRun();
    await runOrder(order(), handlers, { query: c.q as never, ...deps });
    await expectGoverned(c.seen());
  });

  test(`startOrder (${name}) is governed by the PreToolUse hook in permissionMode "default"`, async () => {
    const c = captureRun();
    const run = startOrder(order(), handlers, { query: c.q as never, ...deps });
    await run.done;
    await expectGoverned(c.seen());
  });
}
