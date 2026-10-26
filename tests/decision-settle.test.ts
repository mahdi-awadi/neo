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

// --- ADR-0053 ------------------------------------------------------------------------------------
const DAY = 86_400_000;
const KEEP = ["\\b(prod|production|deploy|release|delete|payments?)\\b"];
const opts = (now: number, expireAfterDays = 7) => ({ now, expireAfterDays, keepPatterns: KEEP });

test("ADR-0053 C1: an older plan card is superseded, and a todo parked on it moves to the current card", () => {
  const d = dec("old", 10);
  expect(staleDecisions(base({ open: [d], asked: [d], replaced: { old: { version: 3, currentId: "new" } }, parked: ["old"] }))).toEqual([
    { id: "old", reason: "replaced by plan card v3", moveParkedTo: "new" },
  ]);
});

test("ADR-0053 C2/C3: a settled plan closes its card even when a todo is parked on it — but not a held plan resumed by Approve & build", () => {
  const d = dec("p", 10);
  for (const status of ["done", "abandoned"] as const) {
    expect(staleDecisions(base({ open: [d], asked: [d], planOf: { p: status }, parked: ["p"] })).map((x) => x.id)).toEqual(["p"]);
  }
  // Executing as another todo (Execute queued the build): the parked continuation is cancelled with the reason.
  expect(staleDecisions(base({ open: [d], asked: [d], planOf: { p: "executing" }, planBuilding: ["p"], parked: ["p"] }))).toEqual([{ id: "p", reason: "plan executing" }]);
  // Approve & build on a held plan: executing, no build todo — the frontend's answer resumes the parked worker.
  expect(staleDecisions(base({ open: [d], asked: [d], planOf: { p: "executing" }, parked: ["p"] }))).toEqual([]);
});

test("ADR-0053 C4: a question expires once its order ended and later work in its folder finished, after expireAfterDays", () => {
  const d = { ...dec("e", 10, "Which colour for the header?"), orderId: "o1" };
  const ended = { e: { endedAt: 50, laterDoneAt: 60 } };
  const f = base({ open: [d], asked: [d], ended });
  expect(staleDecisions(f, opts(10 + 8 * DAY))).toEqual([{ id: "e", reason: "expired: its work ended and later work in gold finished", expired: true }]);
  // Too young, expiry off, no later done work, parked, or no order: it stays open.
  expect(staleDecisions(f, opts(10 + 6 * DAY))).toEqual([]);
  expect(staleDecisions(f, opts(10 + 8 * DAY, 0))).toEqual([]);
  expect(staleDecisions(base({ open: [d], asked: [d], ended: { e: { endedAt: 50 } } }), opts(10 + 8 * DAY))).toEqual([]);
  expect(staleDecisions({ ...f, parked: ["e"] }, opts(10 + 8 * DAY))).toEqual([]);
  const noOrder = dec("e", 10, "Which colour for the header?");
  expect(staleDecisions(base({ open: [noOrder], asked: [noOrder], ended }), opts(10 + 8 * DAY))).toEqual([]);
  // Without the clock (old callers), nothing expires.
  expect(staleDecisions(f)).toEqual([]);
});

test("ADR-0053 C4: an irreversible or prod question never expires", () => {
  const d = { ...dec("e", 10, "Release the hotfix to prod now?"), orderId: "o1" };
  expect(staleDecisions(base({ open: [d], asked: [d], ended: { e: { endedAt: 50, laterDoneAt: 60 } } }), opts(10 + 30 * DAY))).toEqual([]);
  // The words may be in the options rather than the title.
  const o = { ...dec("o", 10, "Next step?"), orderId: "o1", text: "Next step? | Deploy to production | Wait" };
  expect(staleDecisions(base({ open: [o], asked: [o], ended: { o: { endedAt: 50, laterDoneAt: 60 } } }), opts(10 + 30 * DAY))).toEqual([]);
  // A plan card never expires: it follows its plan.
  const p = { ...dec("p", 10, "Plan waiting for your approval: docs/a.md — A"), orderId: "o1" };
  expect(staleDecisions(base({ open: [p], asked: [p], planOf: { p: "sent" }, ended: { p: { endedAt: 50, laterDoneAt: 60 } } }), opts(10 + 30 * DAY))).toEqual([]);
});
