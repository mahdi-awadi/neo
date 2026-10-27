import { test, expect } from "bun:test";
import { staleDecisions, sameQuestion, type SettleFacts } from "../src/engine/decision-settle";

const base = (over: Partial<SettleFacts> = {}): SettleFacts => ({
  open: [],
  asked: [],
  planOf: {},
  parked: [],
  ...over,
});
const dec = (id: string, at: number, question = `q ${id}`, folder: string | undefined = "/home/gold") => ({ id, question, createdAt: at, folder });

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

test("ADR-0054: no rule closes a lone open question just because time passed in its thread (no chat guess)", () => {
  const d = dec("d", 10);
  expect(staleDecisions(base({ open: [d], asked: [d] }))).toEqual([]);
});

test("AC3: a plan's review decision closes when its plan is done, abandoned or executing — and only then", () => {
  const d = dec("p", 10);
  for (const status of ["done", "abandoned", "executing"] as const) {
    expect(staleDecisions(base({ open: [d], asked: [d], planOf: { p: status } }))).toEqual([{ id: "p", reason: `plan ${status === "abandoned" ? "dropped" : status}` }]);
  }
  // An awaiting plan keeps its decision.
  expect(staleDecisions(base({ open: [d], asked: [d], planOf: { p: "sent" } }))).toEqual([]);
});

test("AC4: a decision a waiting todo is parked on is never superseded", () => {
  const a = dec("a", 10, "same?");
  const b = dec("b", 20, "same?");
  // a is parked: never superseded, not even as "asked again" by b.
  expect(staleDecisions(base({ open: [a, b], asked: [a, b], parked: ["a"] }))).toEqual([]);
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

test("ADR-0053: an expired question still takes the operator's late answer; answered, dismissed or superseded ones do not", async () => {
  const { answerable } = await import("../src/engine/decision-settle");
  expect(answerable({ status: "open" })).toBe(true);
  expect(answerable({ status: "expired" })).toBe(true);
  for (const status of ["answered", "dismissed", "superseded"] as const) expect(answerable({ status })).toBe(false);
});

// --- ADR-0054 B3 ---------------------------------------------------------------------------------
test("ADR-0054 B3: an awaiting plan that a later todo built closes its card and marks the plan done", () => {
  const d = dec("p", 10, "Plan waiting for your approval: docs/superpowers/plans/x.md — X");
  expect(staleDecisions(base({ open: [d], asked: [d], planOf: { p: "sent" }, planBuilt: { p: 42 } }), { keepPatterns: KEEP })).toEqual([
    { id: "p", reason: "plan built by todo #42 (it names the plan and ended done)", planDone: true },
  ]);
  // A plan card about prod work is left to the operator, even when a todo names it.
  const prod = dec("q", 10, "Plan waiting for your approval: docs/superpowers/plans/prod.md — prod release");
  expect(staleDecisions(base({ open: [prod], asked: [prod], planOf: { q: "sent" }, planBuilt: { q: 42 } }), { keepPatterns: KEEP })).toEqual([]);
});
