import { test, expect } from "bun:test";
import { staleDecisions, sameQuestion, type SettleFacts } from "../src/engine/decision-settle";

const base = (over: Partial<SettleFacts> = {}): SettleFacts => ({
  open: [],
  asked: [],
  operatorMessages: [],
  doneEnds: [],
  planOf: {},
  parked: [],
  ...over,
});
const dec = (id: string, at: number, question = `q ${id}`, folder: string | undefined = "/home/gold") => ({ id, question, createdAt: at, folder });
const end = (at: number, folder = "/home/gold") => ({ at, folder });

test("sameQuestion: trimmed, whitespace collapsed, case-folded", () => {
  expect(sameQuestion("  Push the  commits?\n", "push the commits?")).toBe(true);
  expect(sameQuestion("Push the commits?", "Push the tags?")).toBe(false);
});

test("AC1: a later decision on the same question supersedes the earlier one", () => {
  const a = dec("aaaaaaaa-1", 10, "Restart the dev container?");
  const b = dec("bbbbbbbb-2", 20, "restart the dev   container?");
  const r = staleDecisions(base({ open: [a, b], asked: [a, b] }));
  expect(r).toEqual([{ id: a.id, reason: "asked again as #bbbbbbbb" }]);
});

test("AC1: separate questions in a row (Q1, Q2) stay open", () => {
  const q1 = dec("1", 10, "Gold-bar Q1: karat?");
  const q2 = dec("2", 11, "Gold-bar Q2: sizes?");
  expect(staleDecisions(base({ open: [q1, q2], asked: [q1, q2] }))).toEqual([]);
});

test("AC2: the operator wrote in the thread after it, and the thread's work then ended done", () => {
  const d = dec("d", 10);
  const r = staleDecisions(base({ open: [d], asked: [d], operatorMessages: [{ ref: "m9g0x", at: 20 }], doneEnds: [end(30)] }));
  expect(r).toEqual([{ id: "d", reason: "answered in chat (m9g0x); the thread's work then finished" }]);
});

test("AC2: needs BOTH — a message after the decision AND a done end after that message", () => {
  const d = dec("d", 10);
  // message before the decision
  expect(staleDecisions(base({ open: [d], asked: [d], operatorMessages: [{ ref: "m1", at: 5 }], doneEnds: [end(30)] }))).toEqual([]);
  // no done end after the message
  expect(staleDecisions(base({ open: [d], asked: [d], operatorMessages: [{ ref: "m1", at: 20 }], doneEnds: [end(15)] }))).toEqual([]);
  // a done end but the operator never wrote
  expect(staleDecisions(base({ open: [d], asked: [d], doneEnds: [end(30)] }))).toEqual([]);
});

test("AC3: a plan's review decision closes when its plan is done, abandoned or executing — and only then", () => {
  const d = dec("p", 10);
  for (const status of ["done", "abandoned", "executing"] as const) {
    expect(staleDecisions(base({ open: [d], asked: [d], planOf: { p: status } }))).toEqual([{ id: "p", reason: `plan ${status === "abandoned" ? "dropped" : status}` }]);
  }
  // An awaiting plan keeps its decision, even when the operator chatted and work finished.
  expect(staleDecisions(base({ open: [d], asked: [d], planOf: { p: "sent" }, operatorMessages: [{ ref: "m", at: 20 }], doneEnds: [end(30)] }))).toEqual([]);
});

test("AC4: a decision a waiting todo is parked on is never superseded", () => {
  const a = dec("a", 10, "same?");
  const b = dec("b", 20, "same?");
  const r = staleDecisions(base({ open: [a, b], asked: [a, b], parked: ["a"], operatorMessages: [{ ref: "m", at: 25 }], doneEnds: [end(30)] }));
  expect(r.map((x) => x.id)).toEqual(["b"]); // b went stale by rule 2; a is parked
});

test("review: answered in chat never closes one of several open questions (a Q1…Q7 batch)", () => {
  const q1 = dec("1", 10, "Q1?");
  const q2 = dec("2", 11, "Q2?");
  const facts = base({ open: [q1, q2], asked: [q1, q2], operatorMessages: [{ ref: "m", at: 20 }], doneEnds: [end(30)] });
  expect(staleDecisions(facts)).toEqual([]);
});

test("review: answered in chat needs done work in the decision's own folder (a 'status?' to the company is not an answer)", () => {
  const d = dec("d", 10);
  expect(staleDecisions(base({ open: [d], asked: [d], operatorMessages: [{ ref: "m", at: 20 }], doneEnds: [end(30, "/home/neo/agent")] }))).toEqual([]);
  // A decision with no folder is never closed by this rule.
  const nf = { id: "n", question: "q", createdAt: 10 }; // no folder
  expect(staleDecisions(base({ open: [nf], asked: [nf], operatorMessages: [{ ref: "m", at: 20 }], doneEnds: [end(30)] }))).toEqual([]);
});
