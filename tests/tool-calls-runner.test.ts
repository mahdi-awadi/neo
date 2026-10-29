// ADR-0058: the Claude runner exposes each running call and stops or backgrounds it with the SDK's own
// controls; the governor hook marks every Bash call with its tool-use id.
import { test, expect } from "bun:test";
import { startOrder, buildGovernorHook, CODEX_TURN } from "../src/engine/session-runner";
import type { Order } from "../src/types";

const order: Order = { id: "o1", source: "neo", folder: "/tmp", task: "t", chatId: 1, createdAt: 0 };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A fake SDK query that streams what the test pushes and records the control calls. */
function fakeSdk() {
  const out: Array<Record<string, unknown>> = [];
  let wake: (() => void) | undefined;
  const calls: string[] = [];
  let ended = false;
  const push = (m: Record<string, unknown>) => {
    out.push(m);
    wake?.();
  };
  const q = () => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (out.length) yield out.shift()!;
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
    interrupt: async () => void calls.push("interrupt"),
    backgroundTasks: async (id?: string) => (calls.push(`background ${id}`), true),
    stopTask: async (id: string) => void calls.push(`stop ${id}`),
  });
  return { q, push, calls, end: () => ((ended = true), wake?.()) };
}
const toolUse = (id: string, command: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });

test("a running Bash call is listed with its SDK task; Background calls backgroundTasks(id)", async () => {
  const sdk = fakeSdk();
  const run = startOrder(order, { onMessage: () => {}, onEscalation: async () => "deny" }, { query: sdk.q as never });
  sdk.push(toolUse("tu1", "git push origin dev"));
  sdk.push({ type: "system", subtype: "task_started", task_id: "bx1", tool_use_id: "tu1" });
  await tick();
  expect(run.tools?.running()).toMatchObject([{ toolUseId: "tu1", tool: "Bash", summary: "git push origin dev", taskId: "bx1" }]);
  expect(await run.tools!.background("tu1")).toEqual({ ok: true, taskId: "bx1" });
  expect(sdk.calls).toEqual(["background tu1"]);
  expect(await run.tools!.background("nope")).toEqual({ ok: false, reason: "not_running" });
  sdk.end();
});

test("Stop = background the call, then stopTask(its task)", async () => {
  const sdk = fakeSdk();
  const run = startOrder(order, { onMessage: () => {}, onEscalation: async () => "deny" }, { query: sdk.q as never });
  sdk.push(toolUse("tu1", "semgrep --config auto ."));
  sdk.push({ type: "system", subtype: "task_started", task_id: "bx9", tool_use_id: "tu1" });
  await tick();
  expect(await run.tools!.stop("tu1")).toEqual({ ok: true, taskId: "bx9" });
  expect(sdk.calls).toEqual(["background tu1", "stop bx9"]);
  sdk.end();
});

test("the governor hook marks a Bash call with its tool-use id (allow and ask alike); other tools untouched", async () => {
  const hook = buildGovernorHook("/tmp", "allow");
  const signal = new AbortController().signal;
  const allow = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as never, "toolu_A", { signal });
  expect(allow).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "export NEO_TOOL_USE_ID=toolu_A; ls" } } });
  const ask = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } } as never, "toolu_B", { signal });
  expect(ask).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask", updatedInput: { command: "export NEO_TOOL_USE_ID=toolu_B; git push" } } });
  expect(await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/a" } } as never, "toolu_C", { signal })).toEqual({});
  expect(await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as never, undefined, { signal })).toEqual({});
});

test("Codex: the current turn is the one stoppable call; background is refused", async () => {
  expect(CODEX_TURN).toBe("codex-turn");
});
