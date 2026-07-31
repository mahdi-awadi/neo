// Cross-SDK resume: an SDK session id belongs to the SDK that minted it.
//
// Field failure (2026-07-31): the company ran on Codex for two days, so its persisted
// sdk_session_id was a CODEX thread id. `/sdk claude` switched the worker back, the engine
// resumed with that same id, and the Claude SDK answered instantly:
//   result{ is_error:true, num_turns:0, errors:["No conversation found with session ID: …"] }
// then threw. The engine read no HTTP status and no `result` text, so it classified the failure
// as an API error of kind "unknown" and told the operator "the API failed (unknown) … the work is
// NOT done" — on every single message, permanently: the run died before it could mint a Claude id
// to replace the stale one, so the next message resumed the same dead id again.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { canResumeWith } from "../src/engine/sdk-choice";
import { runOrder, startOrder } from "../src/engine/session-runner";
import type { Order } from "../src/types";

function order(over: Partial<Order> = {}): Order {
  return { id: "o1", source: "neo", folder: "/tmp", task: "do it", chatId: 1, createdAt: 1000, ...over };
}

const CODEX_ID = "019faab3-115d-7c01-9536-3331f2f046bb";

// --- Layer 1: never hand an id to an SDK that did not mint it. ---

test("lastSessionFor will not hand a codex thread id to the claude SDK", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", folder: "/home/neo/agent", chatId: 9 }));
  led.recordSession("a", CODEX_ID, "codex");

  expect(led.lastSessionFor("/home/neo/agent", 9, "codex")).toBe(CODEX_ID);
  expect(led.lastSessionFor("/home/neo/agent", 9, "subscription")).toBeUndefined();
});

test("lastSessionFor picks the most recent id minted by the REQUESTED provider, not just the newest", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", folder: "/p", chatId: 9, createdAt: 1 }));
  led.recordOrder(order({ id: "b", folder: "/p", chatId: 9, createdAt: 2 }));
  led.recordSession("a", "claude-sess", "subscription");
  led.recordSession("b", CODEX_ID, "codex");

  // Newest overall is the codex thread — claude must still get its own last conversation.
  expect(led.lastSessionFor("/p", 9, "subscription")).toBe("claude-sess");
  expect(led.lastSessionFor("/p", 9, "codex")).toBe(CODEX_ID);
  expect(led.lastSessionFor("/p", 9)).toBe(CODEX_ID); // unfiltered: unchanged behaviour
});

// Only a PROVEN mismatch is refused. An id from before ownership was tracked is still tried — it
// is probably this SDK's, continuity is worth a round-trip, and a dead one now self-heals (below).
test("an untagged legacy session id is still offered for resume", () => {
  const led = openLedger(":memory:");
  led.recordOrder(order({ id: "a", folder: "/p", chatId: 9 }));
  led.recordSession("a", "legacy-id"); // written before ids carried their minting SDK
  expect(led.lastSessionFor("/p", 9)).toBe("legacy-id");
  expect(led.lastSessionFor("/p", 9, "subscription")).toBe("legacy-id");
});

test("canResumeWith blocks a proven cross-SDK id and allows an unowned one", () => {
  expect(canResumeWith("codex", "subscription")).toBe(false); // the field failure
  expect(canResumeWith("subscription", "codex")).toBe(false); // and its mirror image
  expect(canResumeWith("subscription", "subscription")).toBe(true);
  expect(canResumeWith(undefined, "subscription")).toBe(true); // unknown owner => try, then recover
});

test("the registry remembers which SDK minted a live session's id", () => {
  const reg = createRegistry();
  const s = reg.add(order({ folder: "/home/neo/agent" }), 1);
  reg.setSdkSessionId(s.id, CODEX_ID, "codex");
  expect(reg.get(s.id)?.sdkSessionId).toBe(CODEX_ID);
  expect(reg.get(s.id)?.sdkProvider).toBe("codex");
});

// --- Layer 2: a missing conversation is not an API failure — and it self-heals. ---

/** Mirrors the real SDK exactly (verified against @anthropic-ai/claude-agent-sdk): it YIELDS an
 *  is_error result carrying `errors[]` (no `result` text, no api_error_status) and THEN throws. */
function missingConversationQuery(opts: { alwaysMissing?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const received: string[] = [];
  const q = (args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args.options);
    const resume = args.options.resume;
    const missing = opts.alwaysMissing || (typeof resume === "string" && resume !== "");
    return (async function* () {
      if (missing) {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          num_turns: 0,
          session_id: resume ?? "",
          total_cost_usd: 0,
          errors: [`No conversation found with session ID: ${resume ?? "?"}`],
        };
        throw new Error(`Claude Code returned an error result: No conversation found with session ID: ${resume}`);
      }
      const prompt = args.prompt;
      if (typeof prompt === "string" || !(prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]) {
        yield { type: "result", subtype: "success", result: "done fresh", total_cost_usd: 0.01, session_id: "fresh-1" };
        return;
      }
      for await (const m of prompt as AsyncIterable<{ message: { content: string } }>) {
        received.push(m.message.content);
        yield {
          type: "result",
          subtype: "success",
          result: `ack:${m.message.content}`,
          total_cost_usd: 0.01,
          session_id: "fresh-1",
        };
      }
    })();
  };
  return { q, calls, received };
}

const handlers = () => {
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  return {
    events,
    h: {
      onMessage: () => {},
      onEscalation: async () => "deny" as const,
      onEvent: (kind: string, data?: Record<string, unknown>) => events.push({ kind, data }),
    },
  };
};

test("a missing conversation is NOT reported as an API failure", async () => {
  const { q } = missingConversationQuery({ alwaysMissing: true });
  const { h } = handlers();
  const res = await runOrder(order(), h, { query: q as never, resume: CODEX_ID });
  // The old behaviour: apiError "unknown" -> "the API failed (unknown) … the work is NOT done".
  expect(res.apiError).toBeUndefined();
  expect(res.resumeMissing).toBe(true);
  expect(res.summary).toContain("No conversation found");
});

test("runOrder retries once WITHOUT the dead resume id, so the work still runs", async () => {
  const { q, calls } = missingConversationQuery();
  const { h, events } = handlers();
  const res = await runOrder(order(), h, { query: q as never, resume: CODEX_ID });

  expect(calls.length).toBe(2);
  expect(calls[0]?.resume).toBe(CODEX_ID);
  expect(calls[1]?.resume).toBeUndefined(); // fresh start, no dead id
  expect(res.ok).toBe(true);
  expect(res.sessionId).toBe("fresh-1"); // the NEW claude id replaces the stale one
  expect(res.apiError).toBeUndefined();
  expect(events.some((e) => e.kind === "resume_missing")).toBe(true);
});

test("the fresh retry happens at most once (a dead conversation never loops)", async () => {
  const { q, calls } = missingConversationQuery({ alwaysMissing: true });
  const { h } = handlers();
  const res = await runOrder(order(), h, { query: q as never, resume: CODEX_ID });
  expect(calls.length).toBe(2);
  expect(res.ok).toBe(false);
  expect(res.apiError).toBeUndefined(); // still not an API failure — don't blame the API
});

test("a live session re-sends the original brief on the fresh retry (the work is not lost)", async () => {
  const { q, calls, received } = missingConversationQuery();
  const { h } = handlers();
  const run = startOrder(order({ task: "open adminli and save to git" }), h, { query: q as never, resume: CODEX_ID });
  run.close(); // a live session ends only when closed (idle-close / drain), retry or not
  const res = await run.done;

  expect(calls.length).toBe(2);
  expect(calls[1]?.resume).toBeUndefined();
  expect(received).toEqual(["open adminli and save to git"]); // the brief survived the dead resume
  expect(res.ok).toBe(true);
  expect(res.sessionId).toBe("fresh-1");
});

test("a follow-up queued during the dead resume survives into the fresh session", async () => {
  const { q, received } = missingConversationQuery();
  const { h } = handlers();
  const run = startOrder(order({ task: "first" }), h, { query: q as never, resume: CODEX_ID });
  run.followUp("second"); // queued while the dead resume was still failing
  run.close();
  await run.done;
  expect(received).toEqual(["first", "second"]);
});

test("a normal start is untouched: no resume id, no retry", async () => {
  const { q, calls } = missingConversationQuery();
  const { h } = handlers();
  const res = await runOrder(order(), h, { query: q as never });
  expect(calls.length).toBe(1);
  expect(res.ok).toBe(true);
  expect(res.resumeMissing).toBeUndefined();
});
