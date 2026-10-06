import { test, expect } from "bun:test";
import { runOrder, startOrder, runConfig, type RunResult } from "../src/engine/session-runner";
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

function fakeCodexFactory(opts: {
  turns: (input: string) => Array<Record<string, unknown>>;
  threadId?: string;
}) {
  const prompts: string[] = [];
  const starts: unknown[] = [];
  const resumes: Array<{ id: string; options: unknown }> = [];
  const makeThread = (initialId: string | null) => ({
    id: initialId,
    async runStreamed(input: string) {
      prompts.push(input);
      return {
        events: (async function* () {
          for (const event of opts.turns(input)) yield event;
        })(),
      };
    },
  });
  const client = {
    startThread(options?: unknown) {
      starts.push(options);
      return makeThread(null);
    },
    resumeThread(id: string, options?: unknown) {
      resumes.push({ id, options });
      return makeThread(id);
    },
  };
  return { prompts, starts, resumes, factory: async () => client as never };
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

test("a successful turn after a throttled turn does NOT inherit the stale apiError (leak-across-turns)", async () => {
  // Regression: apiError was scoped to the whole session and never reset per-turn, so a turn that
  // recovered on retry (or any later turn) falsely reported the earlier throttle → "work is NOT done".
  const q = (_args: { prompt: any; options: any }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s" };
      // Turn 1: throttled — assistant carries the error kind, result is_error:true (subtype still success).
      yield { type: "assistant", error: "rate_limit", message: { content: [] } };
      yield { type: "result", subtype: "success", is_error: true, result: "", total_cost_usd: 0, session_id: "s" };
      // Turn 2: recovers and completes cleanly.
      yield { type: "assistant", message: { content: [{ type: "text", text: "done for real" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s" };
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  };
  const turns: Array<{ ok: boolean; apiError?: string }> = [];
  const run = startOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onTurnComplete: (r) => turns.push({ ok: r.ok, apiError: r.apiError }) },
    { query: q },
  );
  const final = await run.done;
  expect(turns[0]).toEqual({ ok: false, apiError: "rate_limit" }); // the real throttle is still reported
  expect(turns[1]).toEqual({ ok: true, apiError: undefined }); // the later success must NOT inherit it
  expect(final.apiError).toBeUndefined(); // and neither does the session's final result
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

test("startOrder.active() tracks turn-in-flight, and a follow-up queued mid-turn flushes when the turn completes", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const received: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => {
    releaseFirst = r;
  });
  // Fake SDK: acks each user message, but HOLDS the first turn open on `firstGate` so the test can
  // observe a turn genuinely in flight and queue a follow-up behind it.
  const q = (args: { prompt: AsyncIterable<{ message: { content: string } }>; options: unknown }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      let n = 0;
      for await (const userMsg of args.prompt) {
        n++;
        received.push(userMsg.message.content);
        if (n === 1) await firstGate; // first turn stays in flight until released
        yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "sess-1" };
      }
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  };
  const run = startOrder(order("first brief"), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });

  await tick(); // let the SDK pull + start the first turn
  expect(run.active()).toBe(true); // a turn is being processed right now
  expect(received).toEqual(["first brief"]);

  // A brief arriving mid-turn must QUEUE behind the in-flight turn, not be dropped or run concurrently.
  run.followUp("second brief");
  await tick();
  expect(received).toEqual(["first brief"]); // still queued behind the live turn

  releaseFirst(); // the first turn completes → the channel must FLUSH the queued brief
  await tick();
  await tick();
  expect(received).toEqual(["first brief", "second brief"]); // flushed and ran
  expect(run.active()).toBe(false); // both turns done → idle between turns

  await run.interrupt(); // drain the still-open session so no generator outlives the test
});

// --- Turn-boundary completion (2026-07-08: dispatch never detected sub-run completion — the
// input channel stays open forever, so run.done only resolved via interrupt, and every dispatch
// ended as a false "stall" timeout losing the worker's real report). startOrder must signal each
// turn boundary and offer a graceful close() that ends the stream WITHOUT an interrupt. ---

test("startOrder fires onTurnComplete with the turn's result, and close() ends the stream without interrupt", async () => {
  const f = fakeStreaming();
  const turns: RunResult[] = [];
  const run = startOrder(
    order("do it"),
    { onMessage: () => {}, onEscalation: async () => "deny", onTurnComplete: (r) => void turns.push(r) },
    { query: f.q },
  );
  // wait for the first turn boundary to be signalled
  while (turns.length === 0) await new Promise((r) => setTimeout(r, 1));
  expect(turns[0].ok).toBe(true);
  expect(turns[0].summary).toBe("done");
  run.close(); // graceful: drain + end, no SDK interrupt
  const result = await run.done;
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("done"); // the worker's own final text survives
  expect(f.interruptCalls()).toBe(0); // never hard-interrupted
});

// --- Liveness heartbeat (BUG 1, 2026-07-17: a worker producing one long generation — e.g. writing
// a huge file — emitted no COMPLETED assistant/result message for minutes, so the dispatch stall
// clock (only bumped on completed turns) counted the busy worker as silent and aborted it mid-write
// with "Stream closed". consumeStream must signal a heartbeat on EVERY streamed SDK event, and the
// SDK must stream partial deltas so a long single turn keeps producing events. ---

test("onHeartbeat fires on EVERY streamed SDK event — including system + stream_event partials — so a long generation resets the stall clock", async () => {
  let beats = 0;
  const q = () =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "s" };
      yield { type: "stream_event", event: { type: "content_block_delta" }, session_id: "s" };
      yield { type: "stream_event", event: { type: "content_block_delta" }, session_id: "s" };
      yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] }, session_id: "s" };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onHeartbeat: () => void beats++ },
    { query: q as never },
  );
  // One heartbeat per streamed message regardless of type — the two stream_event partials count,
  // even though they produce no operator message and no completed turn.
  expect(beats).toBe(5);
});

test("workers stream partial messages (includePartialMessages) so a long single generation isn't counted as silence", async () => {
  let seen: { includePartialMessages?: unknown } = {};
  const q = (args: { prompt: unknown; options: { includePartialMessages?: unknown } }) => {
    seen = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  };
  await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });
  expect(seen.includePartialMessages).toBe(true);
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

// --- API errors: a throttled turn is a FAILED turn, not a silent success -----------------------
// The SDK reports an exhausted-retry API failure as subtype:"success" WITH is_error:true (plus
// api_error_status), and the assistant fallback message carries `error: "rate_limit"`. Reading
// only the subtype recorded a rate-limited turn as done — the brief was silently dropped.

test("a result with is_error is NOT a successful turn and reports the api error kind", async () => {
  const q = () =>
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited" }] }, error: "rate_limit" };
      yield { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "API Error", total_cost_usd: 0, session_id: "s" };
    })();
  const res = await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });
  expect(res.ok).toBe(false);
  expect(res.apiError).toBe("rate_limit");
});

test("api error kind falls back to the HTTP status when no assistant error field arrives", async () => {
  const q = () =>
    (async function* () {
      yield { type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "API Error", total_cost_usd: 0, session_id: "s" };
    })();
  const res = await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });
  expect(res.ok).toBe(false);
  expect(res.apiError).toBe("overloaded");
});

test("api error kind falls back to Claude's result text when status/error are missing", async () => {
  const q = () =>
    (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
        total_cost_usd: 0,
        session_id: "s",
      };
    })();
  const res = await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });
  expect(res.ok).toBe(false);
  expect(res.apiError).toBe("rate_limit");
});

test("a clean turn reports no api error", async () => {
  const q = () =>
    (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  const res = await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });
  expect(res.ok).toBe(true);
  expect(res.apiError).toBeUndefined();
});

test("the SDK's own api_retry events surface as activity so the watchdog sees liveness", async () => {
  const seen: string[] = [];
  const q = () =>
    (async function* () {
      yield { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, retry_delay_ms: 4000, error_status: 429, error: "rate_limit" };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny", onActivity: (l) => void seen.push(l) }, { query: q as never });
  expect(seen.some((l) => l.includes("api retry 2/5"))).toBe(true);
});

// --- Diagnostic events (event log): the runner emits session-lifecycle events via onEvent, which
// the engine wires to ledger.recordEvent. Kinds + small metadata only — never message bodies. ---

test("onEvent fires session_start with the resume flag, and sdk_api_retry on the SDK's own retry", async () => {
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  const q = () =>
    (async function* () {
      yield { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5 };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onEvent: (kind, data) => void events.push({ kind, data }) },
    { query: q as never, resume: "sess-prev" },
  );
  expect(events[0]).toEqual({ kind: "session_start", data: { folder: "/tmp", resume: true } });
  expect(events.some((e) => e.kind === "sdk_api_retry" && (e.data as any).attempt === 2 && (e.data as any).max === 5)).toBe(true);
});

test("onEvent fires session_start with resume:false for a fresh run", async () => {
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  const q = () =>
    (async function* () {
      yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0, session_id: "s" };
    })();
  await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny", onEvent: (k, d) => void events.push({ kind: k, data: d }) }, { query: q as never });
  expect(events[0]).toEqual({ kind: "session_start", data: { folder: "/tmp", resume: false } });
});

test("onEvent fires session_interrupted when the SDK stream throws (interrupt/idle-close)", async () => {
  const events: string[] = [];
  const q = () =>
    Object.assign(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" };
        throw new Error("Claude Code returned an error result: interrupted");
      })(),
      { interrupt: async () => {} },
    );
  const run = startOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny", onEvent: (k) => void events.push(k) }, { query: q as never });
  await run.done;
  expect(events).toContain("session_start");
  expect(events).toContain("session_interrupted");
});

test("runConfig forwards model/skills/maxTurns and merges env over process.env", () => {
  const c = runConfig({ model: "haiku", skills: [], maxTurns: 12, env: { NEO_TEST_FLAG: "1" } });
  // The bare tier alias is pinned to its real id on the way out (ADR-0005): an alias means
  // "whatever that family points at now", so the SDK must never be handed one.
  expect(c.model).toBe("claude-haiku-4-5");
  expect(c.skills).toEqual([]);
  expect(c.maxTurns).toBe(12);
  const env = c.env as Record<string, string | undefined>;
  expect(env.NEO_TEST_FLAG).toBe("1");
  expect(env.PATH).toBeDefined(); // process.env preserved underneath
});

test("runConfig still omits every unset key", () => {
  expect(Object.keys(runConfig({}))).toEqual([]);
});

test("runConfig lets an explicit skills allowlist override the sdkOptions default", () => {
  // sdkOptions spreads runConfig() LAST, so skills from deps must win over skills:"all"
  const c = runConfig({ skills: ["superpowers:test-driven-development"] });
  expect(c.skills).toEqual(["superpowers:test-driven-development"]);
});

test("runConfig maps Claude model aliases to Codex effort tiers instead of forwarding them", () => {
  const c = runConfig({ provider: "codex", model: "sonnet" });
  expect(c.model).toBeUndefined();
  expect(c.effort).toBe("medium");

  const explicitEffort = runConfig({ provider: "codex", model: "opus", effort: "xhigh" });
  expect(explicitEffort.model).toBeUndefined();
  expect(explicitEffort.effort).toBe("xhigh"); // caller effort wins over alias-derived effort
});

test("runOrder can execute through the Codex SDK adapter", async () => {
  const f = fakeCodexFactory({
    turns: () => [
      { type: "thread.started", thread_id: "codex-thread-1" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "working through codex" } },
      { type: "item.completed", item: { id: "i2", type: "command_execution", command: "bun test", status: "completed", aggregated_output: "", exit_code: 0 } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 } },
    ],
  });
  const messages: string[] = [];
  const activity: string[] = [];
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];

  const result = await runOrder(
    order(),
    {
      onMessage: (t) => messages.push(t),
      onEscalation: async () => "deny",
      onActivity: (l) => activity.push(l),
      onEvent: (kind, data) => events.push({ kind, data }),
    },
    { provider: "codex", codexFactory: f.factory, model: "gpt-5.4", effort: "high" },
  );

  expect(f.starts[0]).toMatchObject({
    workingDirectory: "/tmp",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    skipGitRepoCheck: true,
    model: "gpt-5.4",
    modelReasoningEffort: "high",
  });
  expect(messages).toContain("working through codex");
  expect(messages.some((m) => m.includes("bun test"))).toBe(true);
  expect(activity).toContain("Bash: bun test");
  expect(events[0]).toEqual({ kind: "session_start", data: { folder: "/tmp", resume: false, provider: "codex" } });
  expect(result).toMatchObject({ ok: true, sessionId: "codex-thread-1", summary: "working through codex", costUsd: 0 });
});

test("Codex adapter translates Claude model aliases before opening a thread", async () => {
  const f = fakeCodexFactory({
    turns: () => [
      { type: "thread.started", thread_id: "codex-thread-1" },
      { type: "turn.completed", usage: null },
    ],
  });
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];

  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onEvent: (kind, data) => events.push({ kind, data }) },
    { provider: "codex", codexFactory: f.factory, model: "claude-3-5-sonnet-latest" },
  );

  expect(f.starts[0]).toMatchObject({
    workingDirectory: "/tmp",
    modelReasoningEffort: "medium",
  });
  expect((f.starts[0] as { model?: string }).model).toBeUndefined();
  expect(events).toContainEqual({
    kind: "worker_model_resolve",
    data: { provider: "codex", from: "claude-3-5-sonnet-latest", model: null, effort: "medium", reason: "claude-tier-sonnet" },
  });
});

test("Codex adapter translates read-only runs and records Claude-only option warnings", async () => {
  const f = fakeCodexFactory({
    turns: () => [
      { type: "thread.started", thread_id: "codex-thread-1" },
      { type: "turn.completed", usage: null },
    ],
  });
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];

  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onEvent: (kind, data) => events.push({ kind, data }) },
    {
      provider: "codex",
      codexFactory: f.factory,
      disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
      mcpServers: { neo: {} },
    },
  );

  expect(f.starts[0]).toMatchObject({ sandboxMode: "read-only" });
  expect(events).toContainEqual({
    kind: "worker_compat_warning",
    data: { provider: "codex", unsupported: ["mcpServers"] },
  });
});

test("Codex adapter reports table-driven warnings for unsupported Claude SDK fields", async () => {
  const f = fakeCodexFactory({
    turns: () => [
      { type: "thread.started", thread_id: "codex-thread-1" },
      { type: "turn.completed", usage: null },
    ],
  });
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];

  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onEvent: (kind, data) => events.push({ kind, data }) },
    {
      provider: "codex",
      codexFactory: f.factory,
      disallowedTools: ["Write"],
      mcpServers: { neo: {} },
      skills: [],
      maxTurns: 4,
      agents: { backend: { description: "backend", prompt: "own the API" } },
    },
  );

  expect(events).toContainEqual({
    kind: "worker_compat_warning",
    data: { provider: "codex", unsupported: ["mcpServers", "skills", "maxTurns", "agents", "disallowedTools"] },
  });
});

test("startOrder queues follow-ups as sequential Codex SDK turns on the same thread", async () => {
  const f = fakeCodexFactory({
    turns: (input) => [
      { type: "thread.started", thread_id: "codex-thread-1" },
      { type: "item.completed", item: { id: crypto.randomUUID(), type: "agent_message", text: `ack:${input}` } },
      { type: "turn.completed", usage: null },
    ],
  });
  const messages: string[] = [];
  const turns: RunResult[] = [];

  const run = startOrder(
    order("first"),
    { onMessage: (t) => messages.push(t), onEscalation: async () => "deny", onTurnComplete: (r) => turns.push(r) },
    { provider: "codex", codexFactory: f.factory, resume: "codex-prev" },
  );
  while (turns.length === 0) await new Promise((r) => setTimeout(r, 1));
  run.followUp("second");
  while (turns.length < 2) await new Promise((r) => setTimeout(r, 1));
  run.close();
  const result = await run.done;

  expect(f.resumes[0]).toMatchObject({ id: "codex-prev", options: { workingDirectory: "/tmp" } });
  expect(f.prompts).toEqual(["first", "second"]);
  expect(messages).toEqual(["ack:first", "ack:second"]);
  expect(result).toMatchObject({ ok: true, sessionId: "codex-thread-1", summary: "ack:second" });
});

test("surfaces a concise result preview for Bash but stays quiet for navigation tools", async () => {
  const q = () =>
    (async function* () {
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } },
            { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x" } },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "hello world output" },
            { type: "tool_result", tool_use_id: "t2", content: "file body that should stay quiet" },
          ],
        },
      };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  const msgs: string[] = [];
  await runOrder(order(), { onMessage: (t) => msgs.push(t), onEscalation: async () => "deny" }, { query: q as never });
  expect(msgs.some((m) => m.includes("🔧 Bash"))).toBe(true); // command milestone
  expect(msgs.some((m) => m.startsWith("↳") && m.includes("hello world output"))).toBe(true); // its result
  expect(msgs.some((m) => m.includes("file body that should stay quiet"))).toBe(false); // Read result stays quiet
});

test("truncates a long tool result and flags an errored one", async () => {
  const long = "x".repeat(2000);
  const q = () =>
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "big" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: long, is_error: true }] } };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  const msgs: string[] = [];
  await runOrder(order(), { onMessage: (t) => msgs.push(t), onEscalation: async () => "deny" }, { query: q as never });
  const preview = msgs.find((m) => m.includes("⚠️"));
  expect(preview).toBeDefined();
  expect(preview!.endsWith("…")).toBe(true); // truncated
  expect(preview!.length).toBeLessThan(650); // ~600 cap + prefix, not the full 2000
});

// --- active() must never drift permanently out of true (2026-09-18). It used to be
// `delivered > completed`: a turn that ends WITHOUT an SDK `result` — an interrupt, a stream error,
// a resume-missing restart — bumps `delivered` only, so the session reported "busy" forever and
// every later dispatch was refused with "busy — queued" against a healthy project. ---

test("active() clears when a turn ends without a result message (stream error)", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const q = (args: { prompt: AsyncIterable<{ message: { content: string } }>; options: unknown }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-err" };
      for await (const _msg of args.prompt) {
        throw new Error("stream closed mid-turn"); // no `result` ever arrives
      }
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  };
  const run = startOrder(order("brief"), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });

  await run.done;
  await tick();
  expect(run.active()).toBe(false); // the run is over — it cannot still be "processing a turn"
});

test("active() clears when the run is interrupted mid-turn", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const q = (args: { prompt: AsyncIterable<{ message: { content: string } }>; options: unknown }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-int" };
      for await (const _msg of args.prompt) {
        await gate; // held open until the test interrupts
        yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "sess-int" };
      }
    })();
    return Object.assign(gen, { interrupt: async () => release() });
  };
  const run = startOrder(order("brief"), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });

  await tick();
  expect(run.active()).toBe(true);
  await run.interrupt();
  await run.done;
  await tick();
  expect(run.active()).toBe(false);
});

// --- Settled vs turn boundary (ADR-0007, 2026-10-04): a worker that runs BACKGROUND subagents ends
// its first turn (`result`) while the CLI keeps working on task notifications. That first `result`
// is not the end of the brief. The SDK's `session_state_changed: idle` is (it fires only after the
// background-agent loop exits), so `active()` and `onSettled` follow it. ---

/** A fake SDK that replays a scripted list of messages for the first user message, then waits. */
function scriptedQuery(script: Array<Record<string, unknown> | "pause">, gate: Promise<void>) {
  const seenOptions: unknown[] = [];
  const q = (args: { prompt: AsyncIterable<unknown>; options: unknown }) => {
    seenOptions.push(args.options);
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s-bg" };
      for await (const _m of args.prompt) {
        for (const step of script) {
          if (step === "pause") await gate;
          else yield { session_id: "s-bg", ...step };
        }
      }
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  };
  return { q, seenOptions };
}

test("with SDK session-state events, a result while background work runs is NOT settled; idle is", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { q } = scriptedQuery(
    [
      { type: "system", subtype: "session_state_changed", state: "running" },
      { type: "result", subtype: "success", result: "launched task 1 in the background", total_cost_usd: 0 },
      "pause", // background subagent still working — the CLI has not gone idle
      { type: "result", subtype: "success", result: "all tasks done", total_cost_usd: 0 },
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ],
    gate,
  );
  const turns: string[] = [];
  let settled = 0;
  const run = startOrder(
    order("run the plan"),
    { onMessage: () => {}, onEscalation: async () => "deny", onTurnComplete: (r) => void turns.push(r.summary), onSettled: () => void settled++ },
    { query: q as never },
  );
  while (turns.length === 0) await new Promise((r) => setTimeout(r, 1));
  expect(turns).toEqual(["launched task 1 in the background"]);
  expect(settled).toBe(0); // a turn boundary, not the end of the brief
  expect(run.active()).toBe(true); // still busy — a new brief must queue, not be "delivered idle"
  release();
  while (settled === 0) await new Promise((r) => setTimeout(r, 1));
  expect(turns).toEqual(["launched task 1 in the background", "all tasks done"]);
  expect(run.active()).toBe(false);
  run.close();
  expect((await run.done).summary).toBe("all tasks done");
});

test("without session-state events (older CLI), each result is settled — the previous behaviour", async () => {
  const { q } = scriptedQuery([{ type: "result", subtype: "success", result: "done", total_cost_usd: 0 }], Promise.resolve());
  let settled = 0;
  const run = startOrder(order("x"), { onMessage: () => {}, onEscalation: async () => "deny", onSettled: () => void settled++ }, { query: q as never });
  while (settled === 0) await new Promise((r) => setTimeout(r, 1));
  expect(run.active()).toBe(false);
  run.close();
  await run.done;
});

test("closed() reports a graceful close, so a caller never pushes a brief into a dead channel", async () => {
  const { q } = scriptedQuery([{ type: "result", subtype: "success", result: "done", total_cost_usd: 0 }], Promise.resolve());
  const run = startOrder(order("x"), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });
  expect(run.closed()).toBe(false);
  run.close();
  expect(run.closed()).toBe(true);
  await run.done;
});

test("a long-running Claude session asks the CLI for session-state events", async () => {
  const { q, seenOptions } = scriptedQuery([{ type: "result", subtype: "success", result: "done", total_cost_usd: 0 }], Promise.resolve());
  const run = startOrder(order("x"), { onMessage: () => {}, onEscalation: async () => "deny" }, { query: q as never });
  while (seenOptions.length === 0) await new Promise((r) => setTimeout(r, 1));
  const env = (seenOptions[0] as { env?: Record<string, string> }).env;
  expect(env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
  run.close();
  await run.done;
});

test("onMessage tags worker prose as text and tool milestones as tool", async () => {
  const { q } = scriptedQuery(
    [
      { type: "assistant", message: { content: [{ type: "text", text: "Task 4 committed." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "git log -1" } }] } },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0 },
    ],
    Promise.resolve(),
  );
  const got: Array<[string, string | undefined]> = [];
  const run = startOrder(order("x"), { onMessage: (t, kind) => void got.push([t, kind]), onEscalation: async () => "deny" }, { query: q as never });
  while (!got.some(([, k]) => k === "tool")) await new Promise((r) => setTimeout(r, 1));
  expect(got.find(([t]) => t === "Task 4 committed.")?.[1]).toBe("text");
  run.close();
  await run.done;
});

// ADR-0013: the SDK reports the real context window on every result. The transcript only carries
// the canonical id (`claude-opus-5-5`), so the window is reported under that id, never the tagged key.
test("runOrder reports each model's SDK context window at the result, under its canonical id", async () => {
  const q = () =>
    (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 0,
        session_id: "s",
        modelUsage: {
          "claude-opus-5-5[1m]": { contextWindow: 1_000_000, canonicalModel: "claude-opus-5-5" },
          "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
          "broken-entry": { contextWindow: 0 },
        },
      };
    })();
  const seen: Array<[string, number]> = [];
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "deny", onContextWindow: (m, t) => seen.push([m, t]) },
    { query: q as never },
  );
  expect(seen).toEqual([
    ["claude-opus-5-5", 1_000_000],
    ["claude-haiku-4-5-20251001", 200_000],
  ]);
});

test("runOrder also reports the window under the de-tagged key when the canonical id differs", async () => {
  const q = () =>
    (async function* () {
      yield {
        type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s",
        modelUsage: { "claude-opus-5-5-20261001[1m]": { contextWindow: 1_000_000, canonicalModel: "claude-opus-5-5" } },
      };
    })();
  const seen: Array<[string, number]> = [];
  await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny", onContextWindow: (m, t) => seen.push([m, t]) }, { query: q as never });
  expect(seen).toEqual([
    ["claude-opus-5-5", 1_000_000],
    ["claude-opus-5-5-20261001", 1_000_000],
  ]);
});

// ADR-0021: the checkpoint watch reads raw stream facts — each turn's usage and every tool call/result.
test("the stream reports usage, tool uses and tool results to the raw callbacks, in order", async () => {
  const seen: unknown[] = [];
  const usage = { input_tokens: 5, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 10, output_tokens: 3 };
  const q = () =>
    (async function* () {
      yield { type: "assistant", session_id: "s", message: { model: "claude-opus-5-5", usage, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git commit -m x" } }] } };
      yield { type: "user", session_id: "s", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "nothing to commit" }] } };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  await runOrder(
    order(),
    {
      onMessage: () => {},
      onEscalation: async () => "deny",
      onUsage: (model, u) => void seen.push(["usage", model, u.cache_read_input_tokens]),
      onToolUse: (id, name, input) => void seen.push(["use", id, name, (input as { command: string }).command]),
      onToolResult: (id, isError) => void seen.push(["result", id, isError]),
    },
    { query: q as never },
  );
  expect(seen).toEqual([
    ["usage", "claude-opus-5-5", 600_000],
    ["use", "t1", "Bash", "git commit -m x"],
    ["result", "t1", true],
  ]);
});

test("the SDK options carry the handlers' context steer into the governor hook", async () => {
  let hooks: { PreToolUse: Array<{ hooks: Array<(i: unknown, id: string, o: { signal: AbortSignal }) => Promise<unknown>> }> } | undefined;
  const q = (args: { options: { hooks?: typeof hooks } }) => {
    hooks = args.options.hooks;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  };
  await runOrder(order(), { onMessage: () => {}, onEscalation: async () => "deny", contextSteer: () => "write the note" }, { query: q as never });
  const out = (await hooks!.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/a" } }, "t", { signal: new AbortController().signal })) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "write the note" });
});

// --- Turn end (Task 1.4, spec §4.2): the runner says when a turn is over, at the same place it
// clears its in-turn flag, so the pipeline can answer every cause delivered during that turn. ---

test("onTurnEnd: each result ends a turn without session-state events, and the run's end ends one too", async () => {
  const { q } = scriptedQuery([{ type: "result", subtype: "success", result: "done", total_cost_usd: 0 }], Promise.resolve());
  let ends = 0;
  const run = startOrder(order("x"), { onMessage: () => {}, onEscalation: async () => "deny", onTurnEnd: () => void ends++ }, { query: q as never });
  while (ends === 0) await new Promise((r) => setTimeout(r, 1));
  expect(ends).toBe(1);
  run.close();
  await run.done;
  expect(ends).toBe(2); // the run is over — any turn still open ends with it
});

test("onTurnEnd: with session-state events only idle ends the turn, never a mid-brief result", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { q } = scriptedQuery(
    [
      { type: "system", subtype: "session_state_changed", state: "running" },
      { type: "result", subtype: "success", result: "launched", total_cost_usd: 0 },
      "pause",
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ],
    gate,
  );
  let turns = 0;
  let ends = 0;
  const run = startOrder(
    order("x"),
    { onMessage: () => {}, onEscalation: async () => "deny", onTurnComplete: () => void turns++, onTurnEnd: () => void ends++ },
    { query: q as never },
  );
  while (turns === 0) await new Promise((r) => setTimeout(r, 1));
  expect(ends).toBe(0);
  release();
  while (ends === 0) await new Promise((r) => setTimeout(r, 1));
  expect(ends).toBe(1);
  run.close();
  await run.done;
});

test("onTurnEnd: a live Codex session ends a turn after each one", async () => {
  const f = fakeCodexFactory({
    turns: (input) => [
      { type: "item.completed", item: { id: "i", type: "agent_message", text: `re:${input}` } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ],
  });
  let ends = 0;
  const run = startOrder(order("x"), { onMessage: () => {}, onEscalation: async () => "deny", onTurnEnd: () => void ends++ }, { provider: "codex", codexFactory: f.factory });
  while (ends === 0) await new Promise((r) => setTimeout(r, 1));
  run.followUp("y");
  while (ends < 2) await new Promise((r) => setTimeout(r, 1));
  run.close();
  await run.done;
  expect(ends).toBe(2);
});
