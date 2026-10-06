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
  /** The button labels — index-addressed by every callback / selection / answer path. Kept a plain
   *  string[] so that logic never changes when a decision gains richer content. */
  options: string[];
  /** Index-aligned with `options`: "what this option means + its trade-off/consequence", shown in the
   *  message body (never on the button — buttons stay short). Optional; absent = bare labels. */
  optionDetails?: string[];
  /** Optional on hand-built asks; normalizeAsk always sets it. Absent = single-select. */
  multiSelect?: boolean;
  /** Index of the option Neo recommends (single-select decisions). Marked with a ⭐ in the body and,
   *  for single-select, on the button. Out-of-range values are dropped by normalizeAsk. */
  recommended?: number;
}

/** A structured ask = 1..MAX_QUESTIONS questions, answered together and resumed once with a combined
 *  answer. There is always an implicit free-form "Other" (the typed-answer path) on top of these.
 *  A MATURED decision (the `ask_operator` path) also carries a title, the problem/root-cause context,
 *  and a recommendation — so the operator sees ONE well-formed decision, not a bare question. */
export interface StructuredAsk {
  questions: StructuredQuestion[];
  /** One-line title of the decision (matured `ask_operator` asks). */
  title?: string;
  /** 1–3 plain-English lines: what happened + the root cause, so the operator sees WHY a decision
   *  is needed (matured `ask_operator` asks). */
  context?: string;
  /** Which option Neo advises + one line of why (the decision still stays with the operator). */
  recommendation?: string;
}

/** Native AskUserQuestion caps at 4 questions; keep parity so a serviced ask never silently drops. */
export const MAX_QUESTIONS = 4;
/** Cap options per question so the callback data stays short and the keyboard stays tappable. */
export const MAX_OPTIONS = 5;

/** Longest option label kept on a button (Telegram truncates long labels anyway). */
const MAX_LABEL = 60;
/** Longest per-option detail kept in the message body — a sentence, not an essay. */
const MAX_DETAIL = 240;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Build a one-question ask (the `ask_operator` MCP path). `multiSelect` defaults to false. */
export function singleQuestionAsk(question: string, options: string[], multiSelect = false): StructuredAsk {
  return normalizeAsk({ questions: [{ question, options, multiSelect }] })!;
}

/** One option of a matured decision: a short button `label`, a `detail` (what it means + its
 *  trade-off/consequence), and an optional `recommended` flag on the one Neo advises. */
export interface MaturedOption {
  label: string;
  detail: string;
  recommended?: boolean;
}

/** The `ask_operator` matured-decision input: ONE decision, fully formed. The Zod schema at the tool
 *  boundary enforces this shape (required fields + 2..MAX_OPTIONS options) so a shapeless question
 *  cannot be raised; `maturedAsk` normalizes it into a StructuredAsk. */
export interface MaturedDecisionInput {
  title: string;
  context: string;
  options: MaturedOption[];
  recommendation: string;
  multiSelect?: boolean;
  /** Optional crisp restatement of the question; defaults to `title`. */
  question?: string;
}

/** Build the single-question StructuredAsk behind a matured `ask_operator` decision: the title
 *  doubles as the question (unless a crisp one is given), each option carries its detail, the
 *  recommended flag becomes the recommended index, and title/context/recommendation ride on the ask.
 *  Returns undefined for a degenerate decision (no title, or fewer than 2 real options) — a
 *  belt-and-suspenders check behind the tool's Zod schema. */
export function maturedAsk(input: MaturedDecisionInput): StructuredAsk | undefined {
  const title = str(input?.title);
  const rawOpts = Array.isArray(input?.options) ? input.options : [];
  const recommendedFlag = rawOpts.findIndex((o) => !!o?.recommended);
  const ask = normalizeAsk({
    title,
    context: str(input?.context),
    recommendation: str(input?.recommendation),
    questions: [
      {
        question: str(input?.question) || title,
        options: rawOpts.map((o) => str(o?.label)),
        optionDetails: rawOpts.map((o) => str(o?.detail)),
        recommended: recommendedFlag >= 0 ? recommendedFlag : undefined,
        multiSelect: !!input?.multiSelect,
      },
    ],
  });
  if (!ask || !title || (ask.questions[0]?.options.length ?? 0) < 2) return undefined;
  return ask;
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
    const rawDetails = (q as { optionDetails?: unknown })?.optionDetails;
    const detailAt = (i: number): string =>
      Array.isArray(rawDetails) ? str(rawDetails[i]).slice(0, MAX_DETAIL) : "";
    // Pair each label with its aligned detail, drop empty-label options, then clamp — so details AND
    // the recommended index stay aligned to the SURVIVING options (indices shift when one is dropped).
    const kept: Array<{ label: string; detail: string; origIdx: number }> = [];
    if (Array.isArray(rawOpts)) {
      rawOpts.forEach((o, i) => {
        const label = str(o).slice(0, MAX_LABEL);
        if (label) kept.push({ label, detail: detailAt(i), origIdx: i });
      });
    }
    const clamped = kept.slice(0, MAX_OPTIONS);
    if (!question || clamped.length === 0) continue; // drop a degenerate question
    const header = str((q as { header?: unknown })?.header) || undefined;
    const details = clamped.map((c) => c.detail);
    const rawRec = (q as { recommended?: unknown })?.recommended;
    const rec = typeof rawRec === "number" ? clamped.findIndex((c) => c.origIdx === rawRec) : -1;
    questions.push({
      question,
      header,
      options: clamped.map((c) => c.label),
      optionDetails: details.some((d) => d.length > 0) ? details : undefined,
      multiSelect: !!(q as { multiSelect?: unknown })?.multiSelect,
      recommended: rec >= 0 ? rec : undefined,
    });
  }
  if (!questions.length) return undefined;
  return {
    questions,
    title: str((raw as { title?: unknown })?.title) || undefined,
    context: str((raw as { context?: unknown })?.context) || undefined,
    recommendation: str((raw as { recommendation?: unknown })?.recommendation) || undefined,
  };
}

/** Map the SDK's native `AskUserQuestion` tool input ({ questions:[{ question, header, multiSelect,
 *  options:[{label,description}] }] }) into a StructuredAsk, or undefined if unparseable. */
export function fromAskUserQuestionInput(input: unknown): StructuredAsk | undefined {
  const rawQuestions = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(rawQuestions)) return undefined;
  const questions = rawQuestions.map((q) => {
    const rawOpts = (q as { options?: unknown })?.options;
    const opts = Array.isArray(rawOpts) ? rawOpts : [];
    return {
      question: str((q as { question?: unknown })?.question),
      header: str((q as { header?: unknown })?.header),
      multiSelect: !!(q as { multiSelect?: unknown })?.multiSelect,
      options: opts.map((o) => str((o as { label?: unknown })?.label)),
      // Native AskUserQuestion options carry a `description` — keep it as the option's detail so a
      // serviced native question renders as richly as a matured ask_operator one (no longer dropped).
      optionDetails: opts.map((o) => str((o as { description?: unknown })?.description)),
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

/** One `• label — detail ⭐` line per option (⭐ on the recommended one). Details go in the BODY, not
 *  on the buttons — so the operator reads what each choice means without a long button label. */
function optionLines(q: StructuredQuestion): string {
  return q.options
    .map((label, i) => {
      const detail = q.optionDetails?.[i];
      const star = q.recommended === i ? " ⭐" : "";
      return `• ${label}${detail ? ` — ${detail}` : ""}${star}`;
    })
    .join("\n");
}

/** The full matured-decision body rendered above the buttons: the title (or the single question),
 *  the problem/root-cause context, each option with its detail (⭐ recommended), and a recommendation
 *  line. Every part is optional and omitted when absent — a bare `singleQuestionAsk` renders as just
 *  its question + option labels (today's read). A multi-question ask keeps the numbered per-question
 *  layout, each question listing its own options. Channel-agnostic plain text; the frontend prepends
 *  the priority badge + #project tag and handles HTML-escaping. */
export function decisionBody(ask: StructuredAsk): string {
  const parts: string[] = [];
  const heading = ask.title || (ask.questions.length === 1 ? ask.questions[0]!.question : "");
  if (heading) parts.push(heading);
  if (ask.context) parts.push(ask.context);
  if (ask.questions.length === 1) {
    parts.push(optionLines(ask.questions[0]!));
  } else {
    ask.questions.forEach((q, i) => {
      const head = `${i + 1}. ${q.header ? `${q.header}: ` : ""}${q.question}${q.multiSelect ? " (pick any)" : ""}`;
      parts.push(`${head}\n${optionLines(q)}`);
    });
  }
  if (ask.recommendation) parts.push(`Recommendation: ${ask.recommendation}`);
  return parts.filter((p) => p.length > 0).join("\n\n");
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
      // ✓ once picked; else ⭐ on the recommended option (single-select only — a multi-select's ✓
      // toggles would clash with a persistent star). The button label stays short; detail is in the body.
      const prefix = picked ? "✓ " : !q.multiSelect && q.recommended === optIdx ? "⭐ " : "";
      const tag = multiQ && q.header ? `${q.header}: ` : "";
      rows.push([{ label: `${prefix}${tag}${label}`.slice(0, MAX_LABEL), data: encodeOptionTap(id, qIdx, optIdx) }]);
    });
  });
  if (needsSubmit(ask)) rows.push([{ label: "✅ Submit", data: encodeSubmit(id) }]);
  rows.push([{ label: "✏️ Other / type an answer", data: encodeOther(id) }]);
  return rows;
}
