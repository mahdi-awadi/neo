// What the task history takes out of a text (ADR-0067, spec "Sources" and "Search"): commit shas, the id
// tokens of a query, the engine blocks Neo wraps around a brief, the continuation wrapper, and boilerplate
// paragraphs. Pure. The engine-block recognizers are text rules on purpose: this module must not import
// dispatch.ts. tests/history-extract.test.ts runs each rule against the real builder, so a text change in a
// builder breaks that test, not the index.
import { createHash } from "node:crypto";
import { CONTINUATION_MARK } from "../todo-title";
import { normalize } from "./normalize";

/** A sha-256 hex of `text`: the hash of a chunk, a source or a paragraph. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── Commit shas and query ids ───────────────────────────────────────────────────────────────────────────

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** 7–40 lower-case hex, not inside a longer word, a hex run, a branch name or after `#` (a color or a
 *  decision id). Git prints shas in lower case; an upper-case run is left to the PNR rule. */
const SHA = /(?<![0-9A-Za-z_#-])[0-9a-f]{7,40}(?![0-9A-Za-z_-])/g;
const hasLetterAndDigit = (s: string): boolean => /[a-z]/i.test(s) && /\d/.test(s);

interface Span { start: number; end: number }

/** The sha-shaped tokens of `text` with their spans; UUIDs are masked first so their parts never match. */
function shaSpans(text: string): Array<Span & { value: string }> {
  const masked = text.replace(UUID, (u) => " ".repeat(u.length));
  const out: Array<Span & { value: string }> = [];
  for (const m of masked.matchAll(SHA)) {
    if (hasLetterAndDigit(m[0])) out.push({ value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The distinct commit shas in `text`, in order of first appearance (stored in `meta.commits`). */
export function findShas(text: string): string[] {
  return [...new Set(shaSpans(text).map((s) => s.value))];
}

export type IdKind = "ref" | "order" | "decision" | "todo" | "plan" | "note" | "thread" | "sha" | "pnr";

export interface IdToken extends Span {
  kind: IdKind;
  /** The id as the store uses it: digits, a lower-case hex or UUID, a `kind:id` ref, `m…`, or the PNR as typed. */
  value: string;
}

/** The id rules, highest priority first. A later rule never takes a span an earlier one took. */
const ID_RULES: Array<{ kind: IdKind; re: RegExp; value: (m: RegExpMatchArray) => string | undefined }> = [
  { kind: "ref", re: /\b(?:todo|order|result|msg|plan|note|att|dec|mem|line):[0-9a-z-]+/gi, value: (m) => m[0].toLowerCase() },
  { kind: "order", re: UUID, value: (m) => m[0].toLowerCase() },
  { kind: "decision", re: /#([0-9a-f]{8})(?![0-9A-Za-z_])/gi, value: (m) => (/[a-f]/i.test(m[1]!) ? m[1]!.toLowerCase() : undefined) },
  { kind: "todo", re: /(?<![\w#])#(\d{1,9})(?!\w)/g, value: (m) => m[1] },
  { kind: "todo", re: /\btodo\s*[:#]?\s*(\d{1,9})\b/gi, value: (m) => m[1] },
  { kind: "plan", re: /\bplan\s*[:#]?\s*(\d{1,9})\b/gi, value: (m) => m[1] },
  { kind: "note", re: /\bnote\s*[:#]?\s*(\d{1,9})\b/gi, value: (m) => m[1] },
  // A message ref (`m4f2`): base36 after `m`; a digit is required so a word ("meeting") is never one.
  { kind: "thread", re: /(?<![\w#])#?m(?=[0-9a-z]{0,7}\d)[0-9a-z]{1,8}\b/g, value: (m) => m[0].replace(/^#/, "") },
  // A PNR-like code: 5–8 upper-case letters and digits, with at least one of each.
  { kind: "pnr", re: /\b[A-Z0-9]{5,8}\b/g, value: (m) => (hasLetterAndDigit(m[0]) ? m[0] : undefined) },
];

/** The id tokens of a query, in text order: refs (`todo:884`), order UUIDs, decision ids (`#ab12cd34`),
 *  todos (`#884`, `todo 884`), plans, notes, message refs (`m4f2`), shas and PNR-like codes. */
export function findIdTokens(text: string): IdToken[] {
  const out: IdToken[] = [];
  const free = (s: Span) => out.every((t) => s.end <= t.start || s.start >= t.end);
  const take = (kind: IdKind, value: string | undefined, start: number, end: number) => {
    if (value !== undefined && free({ start, end })) out.push({ kind, value, start, end });
  };
  for (const [i, rule] of ID_RULES.entries()) {
    for (const m of text.matchAll(rule.re)) take(rule.kind, rule.value(m), m.index!, m.index! + m[0].length);
    // Shas sit between the message refs and the PNR rule.
    if (ID_RULES[i + 1]?.kind === "pnr") for (const s of shaSpans(text)) take("sha", s.value, s.start, s.end);
  }
  return out.sort((a, b) => a.start - b.start);
}

// ── Engine blocks ───────────────────────────────────────────────────────────────────────────────────────

/** Each block the engine puts around a brief, as a text rule (the builder is named for the reader). */
const ENGINE_BLOCKS: Array<{ builder: string; re: RegExp }> = [
  // memory.ts memorySnapshot: prepended with no separator.
  { builder: "memorySnapshot", re: /\[MEMORY — authoritative ground truth\.[\s\S]*?\[END MEMORY\]/g },
  // context-policy.ts handoffPreamble, with its optional sentence about the project's own HANDOFF.md.
  {
    builder: "handoffPreamble",
    re: /This session continues earlier work: Neo handed the previous session off[\s\S]*?--- end of handoff note ---(?:\n\nThe project also has its own HANDOFF\.md\.[^\n]*)?/g,
  },
  // dispatch.ts codebaseMemoryLine, both forms.
  { builder: "codebaseMemoryLine", re: /^REQUIRED — use the `codebase-memory` MCP FIRST\.[^\n]*$/gm },
  { builder: "codebaseMemoryLine", re: /^codebase-memory: no index is available for this project[^\n]*$/gm },
  // dispatch.ts briefForSize, quick and standard (ADR-0072): the brief follows "The order:". Before the big
  // rule, whose opening sentence the standard preamble shares.
  { builder: "briefForSize:quick", re: /QUICK order — Neo's rules for a small fix:[\s\S]*?\nThe order:\n/g },
  { builder: "briefForSize:standard", re: /STANDARD order — Neo's rules for a change of a few files:[\s\S]*?\nThe order:\n/g },
  // dispatch.ts briefWithProjectDocs: the brief follows its last sentence.
  { builder: "briefWithProjectDocs", re: /First read this project's rule and doc \.md files[\s\S]*?Approve & build resumes you\./g },
  // agent-teams.ts teamLeadPreamble: the brief follows "THE TASK:".
  { builder: "teamLeadPreamble", re: /You are the LEAD of a two-engineer team[\s\S]*?\nTHE TASK:\n/g },
  // lanes.ts lanePreamble: one line.
  { builder: "lanePreamble", re: /^SIDE LANE \([a-z-]+\) — [^\n]*\(lane "queue"\)\./gm },
];

/** `text` without the engine blocks, trimmed. */
export function stripEngineBlocks(text: string): string {
  let out = text;
  for (const { re } of ENGINE_BLOCKS) out = out.replace(re, "");
  return out.trim();
}

const ORIGINAL = "\n\nOriginal brief:\n";

/** A continuation brief's original brief (with what was carried after it), however often it was continued.
 *  A continuation without one gives "" (the head is engine text). Other text is returned as it is. */
export function unwrapContinuation(text: string): string {
  let out = text.trim();
  while (out.startsWith(CONTINUATION_MARK)) {
    const at = out.indexOf(ORIGINAL);
    if (at < 0) return "";
    out = out.slice(at + ORIGINAL.length).trim();
  }
  return out;
}

// ── Boilerplate ─────────────────────────────────────────────────────────────────────────────────────────

const PARAGRAPH_BREAK = /\n\s*\n/;

/** The non-empty paragraphs of `text`, trimmed. */
function paragraphs(text: string): string[] {
  return text.split(PARAGRAPH_BREAK).map((p) => p.trim()).filter(Boolean);
}

/** A paragraph's hash: of its normalized text with the spacing collapsed, so older copies of the same
 *  preamble paragraph hash alike. */
function paragraphHash(p: string): string {
  return hashText(normalize(p).replace(/\s+/g, " ").trim());
}

/** The distinct paragraph hashes of `text`, in order (what the boilerplate count adds up). */
export function paragraphHashes(text: string): string[] {
  return [...new Set(paragraphs(text).map(paragraphHash))];
}

/** `text` without the paragraphs whose hash is in `boilerplate`. Unchanged when none is. */
export function removeBoilerplate(text: string, boilerplate: ReadonlySet<string>): string {
  if (boilerplate.size === 0) return text;
  const all = paragraphs(text);
  const kept = all.filter((p) => !boilerplate.has(paragraphHash(p)));
  return kept.length === all.length ? text : kept.join("\n\n");
}
