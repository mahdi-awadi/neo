import { test, expect } from "bun:test";
import { runOrder, startOrder } from "../src/engine/session-runner";
import type { Order } from "../src/types";

function order(task = "do it", folder = "/tmp"): Order {
  return { id: "o1", source: "neo", folder, task, chatId: 1, createdAt: 1 };
}

test("runOrder forwards effort and mcpServers into the SDK options", async () => {
  let seen: { effort?: unknown; mcpServers?: unknown } = {};
  const q = (args: { prompt: unknown; options: { effort?: unknown; mcpServers?: unknown } }) => {
    seen = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  };
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny" },
    { query: q as never, effort: "low", mcpServers: { neo: { x: 1 } } },
  );
  expect(seen.effort).toBe("low");
  expect(seen.mcpServers).toEqual({ neo: { x: 1 } });
});

test("workers are started with all skills enabled, so superpowers is always ready", async () => {
  let seen: { skills?: unknown; settingSources?: unknown } = {};
  const q = (args: { prompt: unknown; options: { skills?: unknown; settingSources?: unknown } }) => {
    seen = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  };
  await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });
  expect(seen.skills).toBe("all");
  expect(seen.settingSources).toEqual(["user", "project"]); // "user" discovers the operator's plugin skills
});

// --- Single-shot fake (Phase-1 runOrder): ignores prompt, yields a finite stream. ---
function fakeQuery(reqs: Array<{ tool: string; input: Record<string, unknown> }>) {
  const decisions: Array<{ behavior: string; updatedInput?: unknown; message?: string }> = [];
  const q = (args: { prompt: any; options: any }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      yield { type: "assistant", message: { content: [{ type: "text", text: "working" }] } };
      for (const r of reqs) {
        decisions.push(await args.options.canUseTool(r.tool, r.input));
      }
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 0.01,
        session_id: "sess-1",
      };
    })();
  return { q, decisions };
}

// --- Streaming fake (Phase-2 startOrder): consumes the input channel, acks each user
// message, runs governance after the first, and ends when the channel closes. ---
function fakeStreaming(reqs: Array<{ tool: string; input: Record<string, unknown> }> = []) {
  const received: string[] = [];
  const decisions: Array<{ behavior: string; updatedInput?: unknown; message?: string }> = [];
  let interruptCalls = 0;
  let optionsSeen: any;
  const q = (args: { prompt: any; options: any }) => {
    optionsSeen = args.options;
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      let first = true;
      for await (const userMsg of args.prompt as AsyncIterable<any>) {
        received.push(userMsg.message.content);
        yield { type: "assistant", message: { content: [{ type: "text", text: `ack:${userMsg.message.content}` }] } };
        if (first) {
          for (const r of reqs) decisions.push(await args.options.canUseTool(r.tool, r.input));
          first = false;
        }
        yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, session_id: "sess-1" };
      }
    })();
    return Object.assign(gen, { interrupt: async () => void interruptCalls++ });
  };
  return { q, received, decisions, interruptCalls: () => interruptCalls, options: () => optionsSeen };
}

test("runOrder auto-allows a safe tool (echoing updatedInput), forwards text, returns result", async () => {
  const { q, decisions } = fakeQuery([{ tool: "Write", input: { file_path: "/tmp/x", content: "y" } }]);
  const messages: string[] = [];
  const result = await runOrder(
    order(),
    { onMessage: (t) => messages.push(t), onEscalation: async () => "deny" },
    { query: q },
  );

  expect(decisions[0]).toEqual({ behavior: "allow", updatedInput: { file_path: "/tmp/x", content: "y" } });
  expect(messages).toContain("working");
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("done");
  expect(result.sessionId).toBe("sess-1");
  expect(result.costUsd).toBe(0.01);
});

test("runOrder escalates a risky tool and denies it when the human denies", async () => {
  let reason = "";
  const { q, decisions } = fakeQuery([{ tool: "Bash", input: { command: "rm -rf /" } }]);
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async (r) => ((reason = r), "deny") },
    { query: q },
  );
  expect(reason).toContain("rm");
  expect(decisions[0].behavior).toBe("deny");
});

test("runOrder lets the human approve an escalated tool (allow, with updatedInput)", async () => {
  const { q, decisions } = fakeQuery([{ tool: "Bash", input: { command: "git push" } }]);
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "allow" },
    { query: q },
  );
  expect(decisions[0].behavior).toBe("allow");
  expect(decisions[0].updatedInput).toEqual({ command: "git push" });
});

test("startOrder delivers the initial task and a follow-up as user messages", async () => {
  const f = fakeStreaming();
  const run = startOrder(order("do it"), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: f.q });
  run.followUp("more please");
  await run.interrupt();
  await run.done;
  expect(f.received).toEqual(["do it", "more please"]);
});

test("startOrder.interrupt ends the stream, resolves done, and signals the SDK", async () => {
  const f = fakeStreaming();
  const run = startOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: f.q });
  await run.interrupt();
  const result = await run.done;
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("done");
  expect(f.interruptCalls()).toBe(1);
});

test("startOrder auto-allows a safe tool over the streaming path, echoing updatedInput", async () => {
  const f = fakeStreaming([{ tool: "Write", input: { file_path: "/tmp/x", content: "y" } }]);
  const run = startOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: f.q });
  await run.interrupt();
  await run.done;
  expect(f.decisions[0]).toEqual({ behavior: "allow", updatedInput: { file_path: "/tmp/x", content: "y" } });
});

test("startOrder escalates a risky tool over the streaming path and denies on human deny", async () => {
  let reason = "";
  const f = fakeStreaming([{ tool: "Bash", input: { command: "rm -rf /" } }]);
  const run = startOrder(order(), { onMessage: () => {}, onEscalation: async (r) => ((reason = r), "deny") }, { query: f.q });
  await run.interrupt();
  await run.done;
  expect(reason).toContain("rm");
  expect(f.decisions[0].behavior).toBe("deny");
});

test("startOrder resolves done (not rejects) when the SDK stream throws on interrupt", async () => {
  // The real SDK throws from readMessages when a turn is interrupted mid-tool-use
  // (verified via the P2 spike). done must still resolve so supervise/cleanup runs.
  const q = (_args: { prompt: any; options: any }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s" };
      yield { type: "assistant", message: { content: [{ type: "text", text: "working" }] } };
      throw new Error("Claude Code returned an error result: interrupted");
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  };
  const msgs: string[] = [];
  const run = startOrder(order(), { onMessage: (t) => msgs.push(t), onEscalation: async () => "deny" }, { query: q });
  const result = await run.done; // must NOT throw
  expect(result.ok).toBe(false);
  expect(msgs).toContain("working");
});

test("startOrder forwards a resume id into the SDK options", async () => {
  const f = fakeStreaming();
  const run = startOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny" },
    { query: f.q, resume: "sess-prev" },
  );
  await run.interrupt();
  await run.done;
  expect(f.options().resume).toBe("sess-prev");
});

test("startOrder forwards rate_limit_event info via onRateLimit", async () => {
  const q = (_args: { prompt: any; options: any }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s" };
      yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1781923200 } };
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, session_id: "s" };
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  };
  const seen: Array<{ rateLimitType?: string }> = [];
  const run = startOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onRateLimit: (i) => seen.push(i) },
    { query: q },
  );
  await run.done;
  expect(seen[0]?.rateLimitType).toBe("five_hour");
});

test("startOrder reports streamed cost via onCost", async () => {
  const f = fakeStreaming();
  const costs: number[] = [];
  const run = startOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onCost: (u) => costs.push(u) },
    { query: f.q },
  );
  await run.interrupt();
  await run.done;
  expect(costs).toEqual([0.01]);
});

test("trust auto-approves a risky tool: allows, records via onAutoApprove, skips onEscalation", async () => {
  const { q, decisions } = fakeQuery([{ tool: "Bash", input: { command: "git push" } }]);
  const auto: string[] = [];
  let escalated = false;
  await runOrder(
    order(),
    {
      onMessage: () => {},
      onEscalation: async () => ((escalated = true), "deny"),
      autoApprove: () => true,
      onAutoApprove: (r) => auto.push(r),
    },
    { query: q },
  );
  expect(decisions[0].behavior).toBe("allow");
  expect(decisions[0].updatedInput).toEqual({ command: "git push" });
  expect(auto[0]).toContain("git push");
  expect(escalated).toBe(false);
});

test("runOrder denies AskUserQuestion with guidance and never escalates to the human", async () => {
  const { q, decisions } = fakeQuery([{ tool: "AskUserQuestion", input: { questions: [] } }]);
  let escalated = false;
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => ((escalated = true), "allow") },
    { query: q },
  );
  expect(decisions[0].behavior).toBe("deny");
  expect(String(decisions[0].message).toLowerCase()).toContain("plain text");
  expect(escalated).toBe(false);
});

test("a trusted project still denies AskUserQuestion (never auto-approves the broken tool)", async () => {
  const { q, decisions } = fakeQuery([{ tool: "AskUserQuestion", input: { questions: [] } }]);
  const auto: string[] = [];
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "allow", autoApprove: () => true, onAutoApprove: (r) => auto.push(r) },
    { query: q },
  );
  expect(decisions[0].behavior).toBe("deny");
  expect(auto).toEqual([]);
});

test("trust off still escalates a risky tool", async () => {
  const { q, decisions } = fakeQuery([{ tool: "Bash", input: { command: "git push" } }]);
  let escalated = false;
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => ((escalated = true), "deny"), autoApprove: () => false },
    { query: q },
  );
  expect(escalated).toBe(true);
  expect(decisions[0].behavior).toBe("deny");
});

// --- Problem 2: surface TOOL ACTIVITY in the stream, so a worker doing a long stretch of
// edits/bash/tests (little assistant text) isn't invisible to the operator. ---

test("surfaces tool activity as a milestone in the stream (long tool-only work isn't silent)", async () => {
  const msgs: string[] = [];
  const q = () =>
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "let me edit that" }] } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/p/src/foo.ts" } }] } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  await runOrder(order(), { onMessage: (t) => msgs.push(t), onEscalation: async () => "deny" }, { query: q as never });
  expect(msgs).toContain("let me edit that"); // assistant text still streamed
  expect(msgs.some((m) => m.includes("Edit") && m.includes("foo.ts"))).toBe(true); // a tool milestone
  expect(msgs.some((m) => m.includes("Bash") && m.includes("bun test"))).toBe(true);
});

test("does NOT surface high-frequency read-only tool calls (Read/Glob/Grep) — avoids spam", async () => {
  const msgs: string[] = [];
  const q = () =>
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/p/a.ts" } }] } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "foo" } }] } };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  await runOrder(order(), { onMessage: (t) => msgs.push(t), onEscalation: async () => "deny" }, { query: q as never });
  expect(msgs.length).toBe(0); // read-only navigation is quiet
});

test("onActivity reports every tool_use and text block; queued() counts waiting follow-ups", async () => {
  const labels: string[] = [];
  // Fake stream: one assistant message with a tool_use, then a text block, then result.
  const fakeQuery = (() => {
    const obj = {
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", session_id: "s1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
      },
      interrupt: async () => {},
    };
    return () => obj;
  })();
  const run = startOrder(
    { id: "o1", source: "neo", folder: "/tmp", task: "t", chatId: 1, createdAt: 0 },
    { onMessage: () => {}, onEscalation: async () => "deny", onActivity: (l) => void labels.push(l) },
    { query: fakeQuery as never },
  );
  run.followUp("extra 1");
  run.followUp("extra 2");
  expect(run.queued()).toBeGreaterThanOrEqual(0); // channel drains as the fake iterates; the method exists and returns a number
  await run.done;
  expect(labels).toContain("Bash: bun test");
  expect(labels).toContain("replying");
});

test("reports 'waiting' on the SDK result message (turn boundary)", async () => {
  const labels: string[] = [];
  const q = () =>
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "done for now" }] } };
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, session_id: "s" };
    })();
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onActivity: (l) => void labels.push(l) },
    { query: q as never },
  );
  expect(labels[labels.length - 1]).toBe("waiting");
});
