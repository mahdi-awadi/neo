// How a brief (or any first line of text) is named in lines and lists. A leaf module so both the
// todo queue and the ledger migrations (legacy thread titles) use the one rule.

/** Max chars of a brief's title in operator lines and lists. */
const TITLE_MAX = 60;

/** The first non-empty line of a brief, bounded — how a todo is named in lines and lists. */
export function todoTitle(brief: string): string {
  const first = brief.split("\n").find((l) => l.trim())?.trim() ?? "";
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

/** The first sentence every continuation brief has started with, in this and earlier wordings (ADR-0059:
 *  here, in the leaf module, so the summary rule and context-policy.ts share it). */
export const CONTINUATION_MARK = "Continue this task in a fresh session.";
const ORIGINAL = "\n\nOriginal brief:\n";
/** Max chars of a todo summary. */
const SUMMARY_MAX = 80;

/** A todo's deterministic summary (ADR-0059): what the operator asked for, in one short line. A continuation
 *  shows its original task; a plan step names its plan; "Operator order (date):" style prefixes, markdown and
 *  everything after the first sentence go. */
export function summarizeBrief(brief: string): string {
  let text = brief;
  while (text.startsWith(CONTINUATION_MARK)) {
    const at = text.indexOf(ORIGINAL);
    if (at < 0) return "Continue the previous session's task";
    text = text.slice(at + ORIGINAL.length);
  }
  let line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!line) return "(empty brief)";
  const plan = /^Execute the plan at (\S+?\.md)\b/.exec(line);
  if (plan) {
    const name = plan[1]!.split("/").pop()!.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/[-_]+/g, " ");
    return bound(`Execute plan: ${name}`);
  }
  // Only a real order label goes ("Operator order (date):", "Operator UI order:", "Operator bug report (…):");
  // a head that says what the work is ("Operator-delegated decisions from the old backlog:") stays.
  line = line.replace(/^Operator(?: (?:UI|bug|ops|console|engine))? (?:order|report|request)(?: \([^)]*\))?:\s*/i, "");
  line = line.replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").trim();
  // The operator's own words, as written: only the first sentence, bounded.
  const sentence = /^(.+?[.!?؟])(\s|$)/.exec(line)?.[1] ?? line;
  return bound(sentence) || "(empty brief)";
}

function bound(s: string): string {
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : s;
}

/** How a todo is named on every surface (ADR-0059): its stored summary, else the one its brief gives. */
export function todoLabel(t: { brief: string; summary?: string }): string {
  return t.summary?.trim() || summarizeBrief(t.brief);
}
