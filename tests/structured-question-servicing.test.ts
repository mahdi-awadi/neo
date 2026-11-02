// ADR-0049: the SDK's native AskUserQuestion cannot carry a context or a recommendation, so it can never
// make a self-explanatory decision card. Where ask_operator is attached (an operator surface), the native
// ask is denied with a steer to ask_operator and its fields — nothing is raised. Without ask_operator (a
// loop, the customer path) it falls back to the governor's plain-text steer.
import { test, expect } from "bun:test";
import { buildCanUseTool, NATIVE_ASK_STEER, type RunHandlers } from "../src/engine/session-runner";
import { decide } from "../src/engine/governor";

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

test("with ask_operator attached, the native AskUserQuestion is denied with a steer to ask_operator and its fields", async () => {
  const canUse = buildCanUseTool(handlers({ askOperator: true }), "/tmp", "neo");
  const verdict = await canUse("AskUserQuestion", NATIVE_INPUT);
  expect(verdict.behavior).toBe("deny");
  expect(verdict.message).toBe(NATIVE_ASK_STEER);
  for (const part of ["ask_operator", "context", "explanation", "recommended", "non-technical"]) expect(NATIVE_ASK_STEER).toContain(part);
});

test("without ask_operator, AskUserQuestion gets the plain-text steer, which asks for the same parts", async () => {
  const canUse = buildCanUseTool(handlers(), "/tmp", "neo");
  const verdict = await canUse("AskUserQuestion", NATIVE_INPUT);
  expect(verdict.behavior).toBe("deny");
  const msg = verdict.message?.toLowerCase() ?? "";
  expect(msg).toContain("plain text");
  for (const part of ["non-technical", "what is happening", "numbered", "recommend"]) expect(msg).toContain(part);
  expect(decide("AskUserQuestion", {}, { folder: "/tmp" })).toEqual({ deny: verdict.message! });
});
