import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { raiseOperatorDecision } from "../src/engine/dispatch";
import { singleQuestionAsk, type StructuredAsk } from "../src/engine/structured-question";

type PostArgs = { rec: { id: string; project?: string; folder?: string }; question: string; options?: string[]; spec?: StructuredAsk };

test("raiseOperatorDecision opens a tracked decision, posts it, and records the message id", async () => {
  const ledger = openLedger(":memory:");
  const posts: PostArgs[] = [];
  const postDecision = async (rec: PostArgs["rec"], question: string, options?: string[], spec?: StructuredAsk) => {
    posts.push({ rec, question, options, spec });
    return { chatId: 999, messageId: 5 };
  };
  const id = await raiseOperatorDecision(
    { ledger, postDecision },
    { project: "acme", folder: "/home/acme", orderId: "o1", chatId: -2, question: "which db?", options: ["Postgres", "Mongo"] },
  );
  const row = ledger.decisionById(id)!;
  expect(row.status).toBe("open");
  expect(row.question).toBe("which db?");
  expect(row.options).toEqual(["Postgres", "Mongo"]);
  // message id recorded so a plain reply to the posted message resolves this exact decision
  expect(row.decisionChatId).toBe(999);
  expect(row.decisionMessageId).toBe(5);
  expect(posts[0]!.spec).toBeUndefined();
});

test("raiseOperatorDecision carries a structured spec through to postDecision AND the row", async () => {
  const ledger = openLedger(":memory:");
  let seenSpec: StructuredAsk | undefined;
  const postDecision = async (_rec: PostArgs["rec"], _q: string, _o?: string[], spec?: StructuredAsk) => {
    seenSpec = spec;
    return { chatId: 1, messageId: 2 };
  };
  const spec = singleQuestionAsk("features?", ["Auth", "Billing"], true);
  const id = await raiseOperatorDecision({ ledger, postDecision }, { folder: "/home/acme", chatId: -2, question: "features?", spec });
  expect(ledger.decisionById(id)!.spec).toEqual(spec);
  expect(seenSpec).toEqual(spec);
});

test("raiseOperatorDecision still queues the decision when no channel post is wired (firewall path)", async () => {
  const ledger = openLedger(":memory:");
  const id = await raiseOperatorDecision({ ledger }, { folder: "/home/x", chatId: 1, question: "q?" });
  expect(ledger.listOpenDecisions().map((d) => d.id)).toContain(id);
  // records a diagnostic decision_raised event even when nothing was posted
  expect(ledger.listEvents({ kind: "decision_raised" }).length).toBe(1);
});
