import { test, expect } from "bun:test";
import {
  singleQuestionAsk,
  normalizeAsk,
  encodeOptionTap,
  encodeSubmit,
  encodeOther,
  parseDecisionCallback,
  emptySelection,
  applyTap,
  isComplete,
  needsSubmit,
  answerText,
  keyboardRows,
  checkDecision,
  decisionBody,
  MAX_OPTIONS,
  type StructuredAsk,
} from "../src/engine/structured-question";

// --- normalization / builders ---

test("singleQuestionAsk builds a one-question ask", () => {
  const ask = singleQuestionAsk("Postgres or Mongo?", ["Postgres", "Mongo"]);
  expect(ask.questions).toHaveLength(1);
  expect(ask.questions[0]).toMatchObject({ question: "Postgres or Mongo?", options: ["Postgres", "Mongo"], multiSelect: false });
});

test("normalizeAsk clamps options to at most MAX_OPTIONS and trims labels", () => {
  const many = Array.from({ length: 9 }, (_, i) => `  opt${i}  `);
  const ask = normalizeAsk({ questions: [{ question: "pick", options: many }] })!;
  expect(ask.questions[0]!.options).toHaveLength(MAX_OPTIONS);
  expect(ask.questions[0]!.options[0]).toBe("opt0"); // trimmed
});

test("normalizeAsk drops empty questions and returns undefined when nothing is left", () => {
  expect(normalizeAsk({ questions: [] })).toBeUndefined();
  expect(normalizeAsk({ questions: [{ question: "", options: ["a", "b"] }] })).toBeUndefined();
  expect(normalizeAsk({ questions: [{ question: "q", options: [] }] })).toBeUndefined();
});

// --- callback encode / decode (backward compatible with the legacy dec:<id>:<idx>) ---

test("option callback round-trips through encode/parse", () => {
  const data = encodeOptionTap("abc-123", 1, 2);
  expect(data).toBe("dec:abc-123:1:2");
  expect(parseDecisionCallback(data)).toEqual({ kind: "option", id: "abc-123", qIdx: 1, optIdx: 2 });
});

test("legacy flat option callback (dec:<id>:<idx>) parses as question 0", () => {
  expect(parseDecisionCallback("dec:xyz:3")).toEqual({ kind: "option", id: "xyz", qIdx: 0, optIdx: 3 });
});

test("submit and other callbacks round-trip and never collide with dec:", () => {
  expect(encodeSubmit("id1")).toBe("decd:id1");
  expect(encodeOther("id1")).toBe("deco:id1");
  expect(parseDecisionCallback("decd:id1")).toEqual({ kind: "submit", id: "id1" });
  expect(parseDecisionCallback("deco:id1")).toEqual({ kind: "other", id: "id1" });
});

test("parseDecisionCallback rejects unrelated callback data", () => {
  expect(parseDecisionCallback("use:proj")).toBeUndefined();
  expect(parseDecisionCallback("a:token")).toBeUndefined();
  expect(parseDecisionCallback("dec:")).toBeUndefined();
});

test("encoded option callback stays well under Telegram's 64-byte limit", () => {
  const data = encodeOptionTap(crypto.randomUUID(), 3, 4);
  expect(new TextEncoder().encode(data).length).toBeLessThan(64);
});

// --- selection reducer ---

test("resolve-on-tap: a single single-select question completes after one tap", () => {
  const ask = singleQuestionAsk("Postgres or Mongo?", ["Postgres", "Mongo"]);
  expect(needsSubmit(ask)).toBe(false); // one tap resolves — no Submit button (today's UX)
  let sel = emptySelection(ask);
  sel = applyTap(ask, sel, 0, 0);
  expect(isComplete(ask, sel)).toBe(true);
  expect(answerText(ask, sel)).toBe("Postgres");
});

test("single-select replaces the prior pick in that question (not accumulate)", () => {
  const ask = singleQuestionAsk("pick one", ["A", "B", "C"]);
  let sel = emptySelection(ask);
  sel = applyTap(ask, sel, 0, 0);
  sel = applyTap(ask, sel, 0, 2); // taps C — replaces A
  expect(answerText(ask, sel)).toBe("C");
});

test("multi-select accumulation: taps toggle and accumulate", () => {
  const ask = singleQuestionAsk("which features?", ["Auth", "Billing", "Search"], true);
  expect(needsSubmit(ask)).toBe(true); // multi-select needs an explicit Submit
  let sel = emptySelection(ask);
  sel = applyTap(ask, sel, 0, 0); // Auth
  sel = applyTap(ask, sel, 0, 2); // + Search
  expect(isComplete(ask, sel)).toBe(true);
  expect(answerText(ask, sel)).toBe("Auth, Search");
  // tapping Auth again removes it (toggle)
  sel = applyTap(ask, sel, 0, 0);
  expect(answerText(ask, sel)).toBe("Search");
});

test("multi-question: needs a submit and only completes when every question is answered", () => {
  const ask: StructuredAsk = {
    questions: [
      { question: "DB?", header: "DB", options: ["Postgres", "Mongo"], multiSelect: false },
      { question: "Regions?", header: "Regions", options: ["US", "EU"], multiSelect: true },
    ],
  };
  expect(needsSubmit(ask)).toBe(true);
  let sel = emptySelection(ask);
  sel = applyTap(ask, sel, 0, 0); // DB = Postgres
  expect(isComplete(ask, sel)).toBe(false); // Regions still unanswered
  sel = applyTap(ask, sel, 1, 1); // Regions += EU
  expect(isComplete(ask, sel)).toBe(true);
  expect(answerText(ask, sel)).toBe("DB: Postgres | Regions: EU");
});

// --- keyboard spec (pure) ---

test("keyboardRows: single single-select shows option buttons + Other, no Submit", () => {
  const ask = singleQuestionAsk("Postgres or Mongo?", ["Postgres", "Mongo"]);
  const rows = keyboardRows("d1", ask);
  const flat = rows.flat();
  expect(flat.map((b) => b.data)).toContain(encodeOptionTap("d1", 0, 0));
  expect(flat.some((b) => b.data === encodeOther("d1"))).toBe(true);
  expect(flat.some((b) => b.data === encodeSubmit("d1"))).toBe(false); // no submit for one-tap flow
});

test("keyboardRows: multi-select marks selected options and shows a Submit button", () => {
  const ask = singleQuestionAsk("features?", ["Auth", "Billing"], true);
  const sel = applyTap(ask, emptySelection(ask), 0, 0); // Auth selected
  const rows = keyboardRows("d2", ask, sel);
  const flat = rows.flat();
  const authBtn = flat.find((b) => b.data === encodeOptionTap("d2", 0, 0))!;
  expect(authBtn.label).toContain("✓"); // selected option is checkmarked
  expect(flat.some((b) => b.data === encodeSubmit("d2"))).toBe(true);
});

// --- decision cards (ADR-0049): checked shape, plain words, one renderer ---

/** The operator's 2026-10-23 Redis question, rewritten so a non-technical reader can decide. */
const REDIS = {
  title: "Which app should move to the new Redis logins first?",
  context:
    "We are switching the shared Redis cache (the fast memory store several apps use) from one shared password to a separate login per app. Each app needs a small update before the switch. The order matters only for risk: the first app to move is the test case.",
  options: [
    { label: "adminli first", explanation: "Update the admin panel first. It has few users, so a mistake affects almost nobody. The bot waits about a day." },
    { label: "Bot first", explanation: "Update the shared bot library first. Every app that uses it gets the change at once, so a mistake reaches more places." },
    { label: "Both, then switch", explanation: "Update both, then switch everything in one step. Fastest, but if something breaks we must find which of the two caused it." },
  ],
  recommended: { option: "adminli first", reason: "Smallest risk: a mistake shows up where few people are affected." },
};

test("checkDecision accepts a complete card and builds the stored ask", () => {
  const r = checkDecision(REDIS);
  if (!r.ok) throw new Error(r.problems.join("; "));
  expect(r.ask.title).toBe(REDIS.title);
  expect(r.ask.context).toBe(REDIS.context);
  expect(r.ask.recommendation).toBe(REDIS.recommended.reason);
  const q = r.ask.questions[0]!;
  expect(q.question).toBe(REDIS.title);
  expect(q.options).toEqual(["adminli first", "Bot first", "Both, then switch"]);
  expect(q.optionDetails).toEqual(REDIS.options.map((o) => o.explanation));
  expect(q.recommended).toBe(0);
  expect(q.multiSelect).toBe(false);
  const multi = checkDecision({ ...REDIS, multiSelect: true });
  expect(multi.ok && multi.ask.questions[0]!.multiSelect).toBe(true);
});

const problemsOf = (input: unknown): string[] => {
  const r = checkDecision(input as never);
  return r.ok ? [] : r.problems;
};

test("checkDecision lists every missing, blank or out-of-range part", () => {
  expect(problemsOf({ ...REDIS, context: "  " }).join("\n")).toContain("context");
  expect(problemsOf({ ...REDIS, title: "" }).join("\n")).toContain("title");
  const blankExpl = problemsOf({ ...REDIS, options: [REDIS.options[0], { label: "Bot first", explanation: "" }] });
  expect(blankExpl.join("\n")).toContain("option 2");
  expect(problemsOf({ ...REDIS, options: [REDIS.options[0]] }).join("\n")).toContain("2 to 5 options");
  const six = Array.from({ length: 6 }, (_, i) => ({ label: `Choice ${i + 1}`, explanation: "what happens" }));
  expect(problemsOf({ ...REDIS, options: six, recommended: { option: "Choice 1", reason: "r" } }).join("\n")).toContain("2 to 5 options");
  expect(problemsOf({ ...REDIS, options: [{ label: "x".repeat(41), explanation: "e" }, REDIS.options[1]] }).join("\n")).toContain("40");
  expect(problemsOf({ ...REDIS, options: [REDIS.options[0], REDIS.options[0]] }).join("\n")).toContain("twice");
  expect(problemsOf({ ...REDIS, recommended: { option: "gopkg bot first", reason: "x" } }).join("\n")).toContain("recommended.option");
  expect(problemsOf({ ...REDIS, recommended: { option: "adminli first", reason: " " } }).join("\n")).toContain("recommended.reason");
  expect(problemsOf({ ...REDIS, context: "x".repeat(801) }).join("\n")).toContain("context");
  expect(problemsOf({ title: "only a title" }).length).toBeGreaterThanOrEqual(3);
  expect(problemsOf(undefined).length).toBeGreaterThan(0);
});

test("checkDecision rejects unexplained jargon and names the field and the token", () => {
  const p1 = problemsOf({ ...REDIS, title: "Redis cut-over (ADR-0188 rollout): which first?" });
  expect(p1.join("\n")).toContain("ADR-0188");
  const p2 = problemsOf({ ...REDIS, options: [REDIS.options[0], { label: "Fix WalletDetailPage", explanation: "fix it" }] });
  expect(p2.join("\n")).toContain("WalletDetailPage");
  expect(p2.join("\n")).toContain("option 2 label");
  const p3 = problemsOf({ ...REDIS, context: "The `outbox` write is not in the same tx as user_list_limit in src/user.go." });
  const j3 = p3.join("\n");
  expect(j3).toContain("`outbox`");
  expect(j3).toContain("user_list_limit");
  expect(j3).toContain("src/user.go");
  expect(problemsOf({ ...REDIS, context: REDIS.context + " See userListLimit." }).join("\n")).toContain("userListLimit");
});

test("checkDecision lets an explained term through, but never in a label", () => {
  const ok = checkDecision({ ...REDIS, context: "This is step two of ADR-0188 (our plan to give each app its own Redis login). " + REDIS.context });
  expect(ok.ok).toBe(true);
  expect(problemsOf({ ...REDIS, options: [{ label: "ADR-0188 (plan) first", explanation: "e" }, REDIS.options[1]] }).join("\n")).toContain("option 1 label");
  // Ordinary product and project names are not jargon.
  expect(checkDecision({ ...REDIS, context: REDIS.context + " It touches WhatsApp, GitHub, PostgreSQL, eticket-v3 and the iPhone app." }).ok).toBe(true);
});

test("decisionBody renders the title, context, numbered options with explanations and the recommendation", () => {
  const r = checkDecision(REDIS);
  if (!r.ok) throw new Error("bad fixture");
  const body = decisionBody(r.ask);
  expect(body.startsWith(REDIS.title)).toBe(true);
  expect(body).toContain(REDIS.context);
  expect(body).toContain("1. adminli first ⭐ — Update the admin panel first.");
  expect(body).toContain("2. Bot first — Update the shared bot library first.");
  expect(body).toContain("3. Both, then switch — Update both");
  expect(body).toContain("⭐ Recommended: 1. adminli first — Smallest risk");
});

test("normalizeAsk carries the new fields and re-aligns optionDetails + recommended when options are filtered", () => {
  const ask = normalizeAsk({
    title: "T",
    context: "C",
    recommendation: "R",
    questions: [
      {
        question: "pick",
        options: ["", "A", "B"], // the empty label is dropped → details/recommended must re-align
        optionDetails: ["dropped", "detA", "detB"],
        recommended: 2, // pointed at "B" before the drop → should shift to index 1 after
      },
    ],
  })!;
  expect(ask.title).toBe("T");
  expect(ask.context).toBe("C");
  expect(ask.recommendation).toBe("R");
  const q = ask.questions[0]!;
  expect(q.options).toEqual(["A", "B"]);
  expect(q.optionDetails).toEqual(["detA", "detB"]);
  expect(q.recommended).toBe(1);
});

test("decisionBody degrades gracefully: no title/context/recommendation → just the question + bare options", () => {
  const body = decisionBody(singleQuestionAsk("Postgres or Mongo?", ["Postgres", "Mongo"]));
  expect(body).toContain("Postgres or Mongo?");
  expect(body).toContain("Postgres");
  expect(body).toContain("Mongo");
  expect(body).not.toContain("Recommended:");
  expect(body).not.toContain("⭐");
});

test("keyboardRows stars the recommended option's button (single-select), labels stay short", () => {
  const r = checkDecision(REDIS);
  if (!r.ok) throw new Error("bad fixture");
  const flat = keyboardRows("d1", r.ask).flat();
  expect(flat.find((b) => b.data === encodeOptionTap("d1", 0, 0))!.label).toContain("⭐");
  expect(flat.find((b) => b.data === encodeOptionTap("d1", 0, 1))!.label).not.toContain("⭐");
});

test("checkDecision does not flag ordinary text: URLs, emails, ratios, framework names, times, money, Arabic", () => {
  const plain = [
    "Our site is built with Next.js and Node.js.",
    "Terms page: https://waselni.com/terms.html and docs at https://example.com/a_b/c.md",
    "Mail mahdi_awadi@example.com about it.",
    "Split the cost 50/50.5 between the two.",
    "The window opens at 10:30 and costs 1,250,000 IQD.",
    "نقل التطبيق إلى تسجيل دخول جديد قبل الساعة 10:30.",
  ];
  for (const extra of plain) {
    const r = checkDecision({ ...REDIS, context: `${REDIS.context} ${extra}` });
    expect(r.ok ? [] : r.problems).toEqual([]);
  }
  expect(checkDecision({ ...REDIS, options: [{ label: "Upgrade Next.js", explanation: "e" }, REDIS.options[1]!], recommended: { option: "Bot first", reason: "r" } }).ok).toBe(true);
  // A real file path is still jargon.
  expect(problemsOf({ ...REDIS, context: `${REDIS.context} See handlers/user.go.` }).join("\n")).toContain("handlers/user.go");
});
