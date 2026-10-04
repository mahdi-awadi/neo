import { test, expect } from "bun:test";
import { runOrder, startOrder, type RunResult } from "../src/engine/session-runner";
import { judgeCodexItem } from "../src/engine/codex-governor";
import type { Order } from "../src/types";

const order = (task = "do it"): Order => ({ id: "o1", source: "neo", folder: "/p", task, chatId: 1, createdAt: 1 });

// Fake Codex client whose turn stops yielding once the turn's AbortSignal fires, like the SDK.
function fakeCodex(turns: (input: string) => Array<Record<string, unknown>>) {
  const starts: unknown[] = [];
  const prompts: string[] = [];
  let aborted = 0;
  const thread = {
    id: "t1" as string | null,
    async runStreamed(input: string, opts?: { signal?: AbortSignal }) {
      prompts.push(input);
      return {
        events: (async function* () {
          for (const e of turns(input)) {
            if (opts?.signal?.aborted) {
              aborted++;
              throw new Error("aborted");
            }
            yield e;
          }
        })(),
      };
    },
  };
  const client = {
    startThread(o?: unknown) {
      starts.push(o);
      return thread;
    },
    resumeThread(_id: string, o?: unknown) {
      starts.push(o);
      return thread;
    },
  };
  return { starts, prompts, aborted: () => aborted, factory: async () => client as never };
}

const cmd = (id: string, command: string) => ({ type: "item.started", item: { id, type: "command_execution", command, aggregated_output: "", status: "in_progress" } });
const msg = (text: string) => ({ type: "item.completed", item: { id: crypto.randomUUID(), type: "agent_message", text } });
const done = { type: "turn.completed", usage: null };

test("judgeCodexItem maps Codex items onto the governor's tool names", () => {
  const ctx = { folder: "/p" };
  expect(judgeCodexItem({ type: "command_execution", command: "bun test" }, ctx)).toEqual({ allow: true });
  expect("escalate" in judgeCodexItem({ type: "command_execution", command: "git push origin main" }, ctx)).toBe(true);
  expect(judgeCodexItem({ type: "file_change", changes: [{ path: "/p/a.ts", kind: "update" }] }, ctx)).toEqual({ allow: true });
  expect("escalate" in judgeCodexItem({ type: "file_change", changes: [{ path: "/p/a.ts" }, { path: "/etc/hosts" }] }, ctx)).toBe(true);
  expect("escalate" in judgeCodexItem({ type: "mcp_tool_call", server: "gmail", tool: "send_message" }, ctx)).toBe(true);
  expect(judgeCodexItem({ type: "mcp_tool_call", server: "gmail", tool: "list_threads" }, { ...ctx, connectors: { gmail: "read" } })).toEqual({ allow: true });
  expect(judgeCodexItem({ type: "web_search", query: "x" }, ctx)).toEqual({ allow: true });
  expect(judgeCodexItem({ type: "agent_message", text: "hi" }, ctx)).toEqual({ allow: true });
});

test("judgeCodexItem denies anything on the run's disallowedTools list", () => {
  const ctx = { folder: "/p", disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebSearch"] };
  expect("deny" in judgeCodexItem({ type: "command_execution", command: "ls" }, ctx)).toBe(true);
  expect("deny" in judgeCodexItem({ type: "file_change", changes: [{ path: "/p/a.ts" }] }, ctx)).toBe(true);
  expect("deny" in judgeCodexItem({ type: "web_search", query: "x" }, ctx)).toBe(true);
});

test("Codex threads get Neo's policy mapped onto sandbox, approval and network settings", async () => {
  const f = fakeCodex(() => [done]);
  await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny" }, { provider: "codex", codexFactory: f.factory });
  expect(f.starts[0]).toMatchObject({
    workingDirectory: "/p",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: false,
  });
});

test("Codex never runs with danger-full-access, and tainted runs get no web search", async () => {
  const f = fakeCodex(() => [done]);
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onEvent: (kind, data) => events.push({ kind, data }) },
    { provider: "codex", codexFactory: f.factory, codexSandboxMode: "danger-full-access" },
  );
  expect(f.starts[0]).toMatchObject({ sandboxMode: "workspace-write" });
  expect(events).toContainEqual({ kind: "governor_clamp", data: { provider: "codex", sandboxMode: "danger-full-access", applied: "workspace-write" } });

  const g = fakeCodex(() => [done]);
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny" },
    { provider: "codex", codexFactory: g.factory, disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"] },
  );
  expect(g.starts[0]).toMatchObject({ sandboxMode: "read-only", webSearchMode: "disabled", networkAccessEnabled: false });
});

test("an escalating Codex command stops the turn and tells the operator", async () => {
  const f = fakeCodex(() => [cmd("c1", "rm -rf build"), msg("deleted"), done]);
  const messages: string[] = [];
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  const turns: RunResult[] = [];
  let asked = 0;
  const result = await runOrder(
    order(),
    {
      onMessage: (t) => messages.push(t),
      onEscalation: async () => { asked++; return "allow"; },
      onEvent: (kind, data) => events.push({ kind, data }),
      onTurnComplete: (r) => turns.push(r),
    },
    { provider: "codex", codexFactory: f.factory },
  );
  expect(asked).toBe(0); // Codex can't pause for an answer, so nothing is offered as approvable
  expect(result.ok).toBe(false);
  expect(result.governorBlock).toContain("risky shell command: rm -rf build");
  expect(result.summary).toContain("blocked by Neo");
  expect(messages).not.toContain("deleted");
  expect(messages.some((m) => m.includes("Neo stopped this Codex turn"))).toBe(true);
  expect(events.some((e) => e.kind === "governor_block" && e.data?.provider === "codex")).toBe(true);
  expect(events.some((e) => e.kind === "worker_error")).toBe(false);
  expect(turns).toHaveLength(1);
});

test("a trusted project lets an escalating Codex command through, like Claude's auto-approve", async () => {
  const f = fakeCodex(() => [cmd("c1", "rm -rf build"), msg("deleted"), done]);
  const auto: string[] = [];
  const result = await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", autoApprove: () => true, onAutoApprove: (r) => auto.push(r) },
    { provider: "codex", codexFactory: f.factory },
  );
  expect(result.ok).toBe(true);
  expect(auto).toEqual(["risky shell command: rm -rf build"]);
});

test("trust never overrides a deny (disallowed tool or denied connector)", async () => {
  const f = fakeCodex(() => [{ type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "gmail", tool: "send_message", arguments: {}, status: "in_progress" } }, done]);
  const result = await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", autoApprove: () => true },
    { provider: "codex", codexFactory: f.factory, connectors: { gmail: "deny" } },
  );
  expect(result.ok).toBe(false);
  expect(result.governorBlock).toContain("connector gmail is denied");
});

test("connector scopes let Codex read through an MCP server without stopping", async () => {
  const f = fakeCodex(() => [{ type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "gmail", tool: "list_threads", arguments: {}, status: "in_progress" } }, msg("found 3"), done]);
  const result = await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny" },
    { provider: "codex", codexFactory: f.factory, connectors: { gmail: "read" } },
  );
  expect(result).toMatchObject({ ok: true, summary: "found 3" });
});

test("a blocked Codex turn keeps the live session open for the operator's follow-up", async () => {
  const f = fakeCodex((input) => (input === "first" ? [cmd("c1", "git push"), done] : [msg(`ack:${input}`), done]));
  const turns: RunResult[] = [];
  const run = startOrder(
    order("first"),
    { onMessage: () => {}, onEscalation: async () => "deny", onTurnComplete: (r) => turns.push(r) },
    { provider: "codex", codexFactory: f.factory },
  );
  while (turns.length === 0) await new Promise((r) => setTimeout(r, 1));
  expect(turns[0].governorBlock).toContain("git push");
  run.followUp("second");
  while (turns.length < 2) await new Promise((r) => setTimeout(r, 1));
  run.close();
  const result = await run.done;
  expect(f.prompts).toEqual(["first", "second"]);
  expect(result).toMatchObject({ ok: true, summary: "ack:second" });
});
