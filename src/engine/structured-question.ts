// A structured operator question: one-or-more questions, each with a few tappable option labels and
// an optional multi-select. This is the PURE core behind Feature 1 — it reuses the decisions queue
// (a structured ask is stored on a decision row as `spec`) and only owns the deterministic logic:
// normalizing an ask, encoding/decoding the Telegram callback data, accumulating a selection, and
// building the (channel-agnostic) keyboard spec. All I/O — posting buttons, editing the message,
// resuming the raising session — stays in the thin Telegram frontend. AI-free; the engine records
// and routes, it never decides the answer.

/** One question in a structured ask. `header` is a short label (native AskUserQuestion's header);
 *  `options` are 2..MAX_OPTIONS short answer labels; `multiSelect` lets the operator pick several. */
export interface StructuredQuestion {
  header?: string;
  question: string;
  options: string[];
  /** Optional on hand-built asks; normalizeAsk always sets it. Absent = single-select. */
  multiSelect?: boolean;
}

/** A structured ask = 1..MAX_QUESTIONS questions, answered together and resumed once with a combined
 *  answer. There is always an implicit free-form "Other" (the typed-answer path) on top of these. */
export interface StructuredAsk {
  questions: StructuredQuestion[];
}

/** Native AskUserQuestion caps at 4 questions; keep parity so a serviced ask never silently drops. */
export const MAX_QUESTIONS = 4;
/** Cap options per question so the callback data stays short and the keyboard stays tappable. */
export const MAX_OPTIONS = 5;

/** Longest option label kept on a button (Telegram truncates long labels anyway). */
const MAX_LABEL = 60;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Build a one-question ask (the `ask_operator` MCP path). `multiSelect` defaults to false. */
export function singleQuestionAsk(question: string, options: string[], multiSelect = false): StructuredAsk {
  return normalizeAsk({ questions: [{ question, options, multiSelect }] })!;
}

/** Clamp + trim a raw ask into a valid StructuredAsk, or `undefined` when nothing usable is left
 *  (no questions, or every question has no text / no options). Never throws on bad input. */
export function normalizeAsk(raw: unknown): StructuredAsk | undefined {
  const rawQuestions = (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(rawQuestions)) return undefined;
  const questions: StructuredQuestion[] = [];
  for (const q of rawQuestions.slice(0, MAX_QUESTIONS)) {
    const question = str((q as { question?: unknown })?.question);
    const rawOpts = (q as { options?: unknown })?.options;
    const options = Array.isArray(rawOpts)
      ? rawOpts.map((o) => str(o).slice(0, MAX_LABEL)).filter((s) => s.length > 0).slice(0, MAX_OPTIONS)
      : [];
    if (!question || options.length === 0) continue; // drop a degenerate question
    const header = str((q as { header?: unknown })?.header) || undefined;
    questions.push({ question, header, options, multiSelect: !!(q as { multiSelect?: unknown })?.multiSelect });
  }
  return questions.length ? { questions } : undefined;
}

/** Map the SDK's native `AskUserQuestion` tool input ({ questions:[{ question, header, multiSelect,
 *  options:[{label,description}] }] }) into a StructuredAsk, or undefined if unparseable. */
export function fromAskUserQuestionInput(input: unknown): StructuredAsk | undefined {
  const rawQuestions = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(rawQuestions)) return undefined;
  const questions = rawQuestions.map((q) => {
    const rawOpts = (q as { options?: unknown })?.options;
    const options = Array.isArray(rawOpts) ? rawOpts.map((o) => str((o as { label?: unknown })?.label)) : [];
    return {
      question: str((q as { question?: unknown })?.question),
      header: str((q as { header?: unknown })?.header),
      multiSelect: !!(q as { multiSelect?: unknown })?.multiSelect,
      options,
    };
  });
  return normalizeAsk({ questions });
}

// --- Telegram callback data (must stay < 64 bytes; ids are UUIDs with no colons) ---

/** `dec:<id>:<qIdx>:<optIdx>` — tap option `optIdx` of question `qIdx`. */
export function encodeOptionTap(id: string, qIdx: number, optIdx: number): string {
  return `dec:${id}:${qIdx}:${optIdx}`;
}
/** `decd:<id>` — submit the accumulated selection (multi-select / multi-question). */
export function encodeSubmit(id: string): string {
  return `decd:${id}`;
}
/** `deco:<id>` — the implicit "Other / type an answer" free-form affordance. */
export function encodeOther(id: string): string {
  return `deco:${id}`;
}

/** A decoded decision-keyboard tap. */
export type DecisionTap =
  | { kind: "option"; id: string; qIdx: number; optIdx: number }
  | { kind: "submit"; id: string }
  | { kind: "other"; id: string };

/** Decode a decision-keyboard callback. Understands the legacy flat `dec:<id>:<idx>` form (mapped to
 *  question 0) so options posted before this change still resolve. Returns undefined for anything
 *  that isn't a decision callback. */
export function parseDecisionCallback(data: string): DecisionTap | undefined {
  if (data.startsWith("decd:")) {
    const id = data.slice("decd:".length);
    return id ? { kind: "submit", id } : undefined;
  }
  if (data.startsWith("deco:")) {
    const id = data.slice("deco:".length);
    return id ? { kind: "other", id } : undefined;
  }
  if (data.startsWith("dec:")) {
    const parts = data.split(":");
    const id = parts[1];
    if (!id) return undefined;
    if (parts.length >= 4) return { kind: "option", id, qIdx: Number(parts[2]), optIdx: Number(parts[3]) };
    if (parts.length === 3) return { kind: "option", id, qIdx: 0, optIdx: Number(parts[2]) }; // legacy flat
    return undefined;
  }
  return undefined;
}

// --- selection state (accumulated across taps; pure) ---

/** Selected option indices per question. `sel[q]` is the picks for question q (one for single-select,
 *  any number for multi-select). Held ephemerally by the frontend while the operator answers. */
export type Selection = number[][];

/** A fresh, empty selection sized to the ask. */
export function emptySelection(ask: StructuredAsk): Selection {
  return ask.questions.map(() => []);
}

/** Apply one option tap. Single-select replaces that question's pick; multi-select toggles it.
 *  Pure — returns a new Selection, never mutates the input. Out-of-range taps are ignored. */
export function applyTap(ask: StructuredAsk, sel: Selection, qIdx: number, optIdx: number): Selection {
  const q = ask.questions[qIdx];
  if (!q || optIdx < 0 || optIdx >= q.options.length) return sel;
  const next = ask.questions.map((_, i) => [...(sel[i] ?? [])]);
  if (q.multiSelect) {
    const arr = next[qIdx]!;
    const at = arr.indexOf(optIdx);
    if (at >= 0) arr.splice(at, 1);
    else arr.push(optIdx);
  } else {
    next[qIdx] = [optIdx];
  }
  return next;
}

/** True once every question has at least one selected option. */
export function isComplete(ask: StructuredAsk, sel: Selection): boolean {
  return ask.questions.every((_, i) => (sel[i]?.length ?? 0) > 0);
}

/** Whether the ask needs an explicit Submit button. A single single-select question resolves on one
 *  tap (today's UX); multi-select or multiple questions accumulate, so they need Submit. */
export function needsSubmit(ask: StructuredAsk): boolean {
  return ask.questions.length > 1 || ask.questions.some((q) => q.multiSelect);
}

/** The combined answer string delivered back to the raising worker. One question → the joined labels;
 *  several questions → `Header: a, b | Header2: c` (falls back to `Q1`/`Q2` when a header is absent). */
export function answerText(ask: StructuredAsk, sel: Selection): string {
  const perQuestion = ask.questions.map((q, i) => (sel[i] ?? []).map((o) => q.options[o]).filter(Boolean).join(", "));
  if (ask.questions.length === 1) return perQuestion[0] ?? "";
  return ask.questions.map((q, i) => `${q.header || `Q${i + 1}`}: ${perQuestion[i]}`).join(" | ");
}

/** The message body shown above the buttons: the single question's text, or a numbered list of
 *  questions (with headers) when there are several — so nothing is hidden on a multi-question ask. */
export function questionSummary(ask: StructuredAsk): string {
  if (ask.questions.length === 1) return ask.questions[0]!.question;
  return ask.questions
    .map((q, i) => `${i + 1}. ${q.header ? `${q.header}: ` : ""}${q.question}${q.multiSelect ? " (pick any)" : ""}`)
    .join("\n");
}

// --- keyboard spec (channel-agnostic; the frontend maps it to a grammy InlineKeyboard) ---

/** One tappable button: a display `label` and the callback `data` it fires. */
export interface KbButton {
  label: string;
  data: string;
}

/** Build the decision keyboard as rows of buttons (pure data). Each option is its own row (labels can
 *  be long), checkmarked when selected; for a multi-question ask the button carries its question
 *  header so the operator can tell them apart. A Submit row is added only when the ask needs one
 *  (multi-select / multi-question); the implicit "Other / type an answer" row is always last. */
export function keyboardRows(id: string, ask: StructuredAsk, sel: Selection = emptySelection(ask)): KbButton[][] {
  const rows: KbButton[][] = [];
  const multiQ = ask.questions.length > 1;
  ask.questions.forEach((q, qIdx) => {
    q.options.forEach((label, optIdx) => {
      const picked = (sel[qIdx] ?? []).includes(optIdx);
      const prefix = picked ? "✓ " : "";
      const tag = multiQ && q.header ? `${q.header}: ` : "";
      rows.push([{ label: `${prefix}${tag}${label}`.slice(0, MAX_LABEL), data: encodeOptionTap(id, qIdx, optIdx) }]);
    });
  });
  if (needsSubmit(ask)) rows.push([{ label: "✅ Submit", data: encodeSubmit(id) }]);
  rows.push([{ label: "✏️ Other / type an answer", data: encodeOther(id) }]);
  return rows;
}
