import { test, expect } from "bun:test";
import {
  singleQuestionAsk,
  normalizeAsk,
  fromAskUserQuestionInput,
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
  questionSummary,
  maturedAsk,
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

test("fromAskUserQuestionInput maps the native AskUserQuestion tool shape", () => {
  const native = {
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
      {
        question: "Which regions?",
        header: "Regions",
        multiSelect: true,
        options: [{ label: "US" }, { label: "EU" }, { label: "ME" }],
      },
    ],
  };
  const ask = fromAskUserQuestionInput(native)!;
  expect(ask.questions).toHaveLength(2);
  expect(ask.questions[0]).toMatchObject({ question: "Which database?", header: "DB", options: ["Postgres", "Mongo"], multiSelect: false });
  expect(ask.questions[1]).toMatchObject({ header: "Regions", options: ["US", "EU", "ME"], multiSelect: true });
});

test("fromAskUserQuestionInput returns undefined for garbage", () => {
  expect(fromAskUserQuestionInput(undefined)).toBeUndefined();
  expect(fromAskUserQuestionInput({})).toBeUndefined();
  expect(fromAskUserQuestionInput({ questions: [{ question: "q" }] })).toBeUndefined(); // no options
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

test("questionSummary: single question is the plain text; multi is a numbered list", () => {
  expect(questionSummary(singleQuestionAsk("Postgres or Mongo?", ["a", "b"]))).toBe("Postgres or Mongo?");
  const multi: StructuredAsk = {
    questions: [
      { question: "DB?", options: ["a", "b"] },
      { question: "Region?", options: ["c", "d"] },
    ],
  };
  const sum = questionSummary(multi);
  expect(sum).toContain("1.");
  expect(sum).toContain("DB?");
  expect(sum).toContain("2.");
  expect(sum).toContain("Region?");
});

// --- matured decisions (schema-enforced shape: title + context + option details + recommendation) ---

const MATURED = {
  title: "Fix the log-ingestion consumer",
  context: "Vector is deployed but not consuming: the JetStream consumer was never created, so wire logs queue and drop after retention. Root cause is missing consumer wiring, not Vector.",
  options: [
    { label: "Redeploy Vector", detail: "quickest; but does not create the missing consumer, so ingestion still fails" },
    { label: "JetStream + consumer", detail: "create the durable consumer Vector reads from; fixes the root cause with existing infra", recommended: true },
    { label: "Dedicated Go consumer", detail: "most control; a new service to own and deploy" },
  ],
  recommendation: "JetStream + consumer — fixes the root cause with infra we already run, no new service to maintain.",
};

test("maturedAsk builds a single-question ask carrying title/context/recommendation + per-option details", () => {
  const ask = maturedAsk(MATURED)!;
  expect(ask.title).toBe(MATURED.title);
  expect(ask.context).toBe(MATURED.context);
  expect(ask.recommendation).toBe(MATURED.recommendation);
  expect(ask.questions).toHaveLength(1);
  const q = ask.questions[0]!;
  expect(q.question).toBe(MATURED.title); // title doubles as the question when none given
  expect(q.options).toEqual(["Redeploy Vector", "JetStream + consumer", "Dedicated Go consumer"]);
  expect(q.optionDetails).toEqual([MATURED.options[0]!.detail, MATURED.options[1]!.detail, MATURED.options[2]!.detail]);
  expect(q.recommended).toBe(1); // index of the option flagged recommended
  expect(q.multiSelect).toBe(false);
});

test("maturedAsk keeps a distinct crisp question and honours multiSelect", () => {
  const ask = maturedAsk({ ...MATURED, question: "How do we fix ingestion?", multiSelect: true })!;
  expect(ask.questions[0]!.question).toBe("How do we fix ingestion?");
  expect(ask.questions[0]!.multiSelect).toBe(true);
});

test("maturedAsk rejects degenerate input (fewer than 2 usable options, or empty title)", () => {
  expect(maturedAsk({ ...MATURED, options: [MATURED.options[0]!] })).toBeUndefined();
  expect(maturedAsk({ ...MATURED, title: "  " })).toBeUndefined();
  expect(maturedAsk({ ...MATURED, options: [{ label: "", detail: "x" }, { label: "", detail: "y" }] })).toBeUndefined();
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

test("fromAskUserQuestionInput keeps each native option's description as optionDetails", () => {
  const ask = fromAskUserQuestionInput({
    questions: [
      {
        question: "Which database?",
        header: "DB",
        options: [
          { label: "Postgres", description: "relational, strong consistency" },
          { label: "Mongo", description: "document, flexible schema" },
        ],
      },
    ],
  })!;
  expect(ask.questions[0]!.options).toEqual(["Postgres", "Mongo"]);
  expect(ask.questions[0]!.optionDetails).toEqual(["relational, strong consistency", "document, flexible schema"]);
});

test("decisionBody renders title, context, each option with its detail, a starred recommendation, and a recommendation line", () => {
  const body = decisionBody(maturedAsk(MATURED)!);
  expect(body.startsWith(MATURED.title)).toBe(true); // title is the first line (badge/#project prepend before it)
  expect(body).toContain(MATURED.context);
  expect(body).toContain("Redeploy Vector — quickest");
  expect(body).toContain("JetStream + consumer — create the durable consumer");
  expect(body).toContain("⭐"); // the recommended option is marked
  expect(body).toContain("Recommendation:");
  expect(body).toContain("no new service to maintain");
});

test("decisionBody degrades gracefully: no title/context/recommendation → just the question + bare options", () => {
  const body = decisionBody(singleQuestionAsk("Postgres or Mongo?", ["Postgres", "Mongo"]));
  expect(body).toContain("Postgres or Mongo?");
  expect(body).toContain("Postgres");
  expect(body).toContain("Mongo");
  expect(body).not.toContain("Recommendation:");
  expect(body).not.toContain("⭐");
});

test("keyboardRows stars the recommended option's button (single-select), labels stay short", () => {
  const ask = maturedAsk(MATURED)!;
  const flat = keyboardRows("d1", ask).flat();
  const recBtn = flat.find((b) => b.data === encodeOptionTap("d1", 0, 1))!; // "JetStream + consumer"
  expect(recBtn.label).toContain("⭐");
  const otherBtn = flat.find((b) => b.data === encodeOptionTap("d1", 0, 0))!;
  expect(otherBtn.label).not.toContain("⭐");
});
