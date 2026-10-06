/** One brief template per attention kind (ADR-0018, spec §7 "one tap → todo"): the facts, the URL and
 *  the definition of done the worker gets when the operator taps `→ todo` on an item. Data, not
 *  code paths: a new kind adds one entry (a test checks every producer kind has one). */
import type { AttentionRow } from "./ledger";

interface BriefTemplate {
  /** What to do, one line. `{title}` is the item's title. */
  task: string;
  /** When the work is done. */
  doneWhen: string;
}

export const ATTENTION_BRIEFS: Record<string, BriefTemplate> = {
  approval_stuck: {
    task: "An approval has been pending a long time in this project: {title}. Find what the worker was trying to do and finish it another way, or report why it needs that approval.",
    doneWhen: "the blocked step is done or explained, and nothing waits for an approval",
  },
  dispatch_spinning: {
    task: "A dispatch in this project repeated itself with no new commit or note: {title}. Find why it loops, fix the cause, and finish the step.",
    doneWhen: "the step is finished and committed, or the reason it cannot be is written down",
  },
  queue_paused: {
    task: "This project's todo queue has been paused for a long time: {title}. Find why it was paused (usually a failed todo), fix that, then resume the queue with the todo tool.",
    doneWhen: "the cause is fixed and the queue runs again",
  },
  thread_failed: {
    task: "A thread failed in this project: {title}. Read what failed, fix it, and finish the work it was doing.",
    doneWhen: "the work of that thread is done, tested and committed",
  },
  thread_waiting: {
    task: "A thread in this project has waited a long time: {title}. Find what it waits for (a decision, an approval) and either finish it or state the one question the operator must answer.",
    doneWhen: "the thread is no longer waiting, or the open question is stated clearly",
  },
  decision_stale: {
    task: "A decision has been open a long time: {title}. Collect the facts the operator needs to decide (options, cost, risk, your recommendation) in one short message.",
    doneWhen: "the operator has one short message with the options and a recommendation",
  },
  ctx_window_suspect: {
    task: "The engine measured an impossible context % (over 100) in this project: {title}. Find which context window the engine used for this model and why it is wrong.",
    doneWhen: "the window used for this model is correct, or the cause is reported",
  },
  dirty: {
    task: "Work was left uncommitted in this project: {title}. Review the changes: commit what is finished and green, revert what is not wanted, and say what was left and why.",
    doneWhen: "`git status` is clean, or every remaining change is explained",
  },
  restart_gated: {
    task: "Neo has changes that are built but not running: {title}. Check the change is ready (tests and types green on the branch), then list what a restart activates. Do NOT restart or reload Neo.",
    doneWhen: "the list of what a restart activates is ready for the operator",
  },
};

/** The todo brief for an item: its template, the facts and the URL. Undefined: no template (the
 *  test makes that impossible for a known kind). */
export function attentionBrief(row: Pick<AttentionRow, "kind" | "title" | "detail" | "url" | "project">): string | undefined {
  const t = ATTENTION_BRIEFS[row.kind];
  if (!t) return undefined;
  const lines = [t.task.replaceAll("{title}", row.title)];
  if (row.detail) lines.push(`Facts: ${row.detail}`);
  if (row.url) lines.push(`Link: ${row.url}`);
  lines.push(`Done when: ${t.doneWhen}.`);
  return lines.join("\n");
}
