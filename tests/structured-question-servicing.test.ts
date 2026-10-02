// Feature 1: the SDK's native AskUserQuestion tool must be SERVICED (not hard-denied) when the
// engine wires the onStructuredQuestion hook — it raises a tracked decision (tappable buttons on the
// Decisions channel) and steers the worker to check-point + STOP, exactly like ask_operator. Without
// the hook (bare worker / customer path) it falls back to today's plain "ask in plain text" steer.
import { test, expect } from "bun:test";
import { buildCanUseTool, type RunHandlers } from "../src/engine/session-runner";
import type { StructuredAsk } from "../src/engine/structured-question";

function handlers(over: Partial<RunHandlers> = {}): RunHandlers {
  return { onMessage: () => {}, onEscalation: async () => "deny", ...over };
}

const NATIVE_INPUT = {
  questions: [
    {
      question: "Which database?",
      header: "DB",
      multiSelect: false,
      options: [
        { label: "Postgres", description: "relational" },
        { label: "Mongo", description: "document" },
      ],
    },
  ],
};

test("AskUserQuestion is serviced when the hook is wired: raises the ask + denies with a STOP steer", async () => {
  let raised: StructuredAsk | undefined;
  const canUse = buildCanUseTool(handlers({ onStructuredQuestion: (ask) => void (raised = ask) }), "/tmp", "neo");
  const verdict = await canUse("AskUserQuestion", NATIVE_INPUT);

  // The worker gets a deny that steers it to check-point + STOP (the fire-and-suspend contract).
  expect(verdict.behavior).toBe("deny");
  expect(verdict.message?.toLowerCase()).toContain("stop");
  // The hook received the parsed structured ask (routed into the decisions machinery).
  expect(raised?.questions[0]).toMatchObject({ question: "Which database?", options: ["Postgres", "Mongo"] });
});

test("without the hook, AskUserQuestion falls back to the plain 'ask in plain text' steer", async () => {
  const canUse = buildCanUseTool(handlers(), "/tmp", "neo"); // no onStructuredQuestion
  const verdict = await canUse("AskUserQuestion", NATIVE_INPUT);
  expect(verdict.behavior).toBe("deny");
  expect(verdict.message?.toLowerCase()).toContain("plain text");
});

test("an unparseable AskUserQuestion input with the hook still fails safe to the plain steer", async () => {
  let called = false;
  const canUse = buildCanUseTool(handlers({ onStructuredQuestion: () => void (called = true) }), "/tmp", "neo");
  const verdict = await canUse("AskUserQuestion", { questions: [] }); // nothing to raise
  expect(verdict.behavior).toBe("deny");
  expect(called).toBe(false); // never raised an empty ask
  expect(verdict.message?.toLowerCase()).toContain("plain text");
});

test("a throwing onStructuredQuestion hook never wedges the callback (fails safe to the plain steer)", async () => {
  const canUse = buildCanUseTool(
    handlers({ onStructuredQuestion: () => { throw new Error("channel down"); } }),
    "/tmp",
    "neo",
  );
  const verdict = await canUse("AskUserQuestion", NATIVE_INPUT);
  expect(verdict.behavior).toBe("deny"); // still a governed deny, never a thrown/hung callback
});
