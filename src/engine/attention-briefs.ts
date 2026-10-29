/** One brief template per attention kind (ADR-0018, spec §7 "one tap → todo"): the facts, the URL and
 *  the definition of done the worker gets when the operator taps `→ todo` on an item. Data, not
 *  code paths: a new kind adds one entry (a test checks every producer kind has one). */
import type { AttentionRow } from "./ledger";
import { noteDetail } from "./project-notes";

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
  // Project notes (ADR-0043): {from} is the sender project, {id} the note number.
  note_finding: {
    task: "Project {from} found something this project owns (note #{id}): {title}. Check it against the code; if it holds, fix the cause and commit.",
    doneWhen: "the finding is fixed, tested and committed, then `project_notes resolve id={id} how=fixed commit=<sha>` — or `how=not_needed` with the reason when it does not hold",
  },
  note_request: {
    task: "Project {from} asks this project to do work (note #{id}): {title}. Do it when it fits this project's rules; otherwise say why not.",
    doneWhen: "the work is done, tested and committed, then `project_notes resolve id={id} how=fixed commit=<sha>` — or `how=not_needed` with the reason",
  },
  note_fyi: {
    task: "Project {from} sent this project information (note #{id}): {title}. Update what it affects here (code, docs, notes).",
    doneWhen: "what the note affects is updated and committed, then `project_notes resolve id={id} how=fixed commit=<sha>` — or `how=not_needed` with the reason",
  },
  // Skillify (ADR-0044): the same task given to this project again and again, with no tool that fits.
  skillify_repeat: {
    task: "The operator gave this project the same kind of task again and again: {title}. Read those past todos and how they were done. Write the steps down once: as a skill in this project's `.claude/skills/`, or, when other projects would use it too, send Neo a `project_notes` request for a shared recipe card.",
    doneWhen: "the skill is committed in this project, or the recipe request is sent to Neo, and the item names which",
  },
  restart_gated: {
    task: "Neo has changes that are built but not running: {title}. Check the change is ready (tests and types green on the branch), then list what a restart activates. Do NOT restart or reload Neo.",
    doneWhen: "the list of what a restart activates is ready for the operator",
  },
};

/** The todo brief for an item: its template, the facts and the URL. Undefined: no template (the
 *  test makes that impossible for a known kind). */
export function attentionBrief(
  row: Pick<AttentionRow, "kind" | "title" | "detail" | "url" | "project"> & Partial<Pick<AttentionRow, "id" | "source" | "fromProject">>,
): string | undefined {
  const t = ATTENTION_BRIEFS[row.kind];
  if (!t) return undefined;
  const fill = (s: string) => s.replaceAll("{title}", row.title).replaceAll("{from}", row.fromProject ?? "?").replaceAll("{id}", String(row.id ?? "?"));
  const lines = [fill(t.task)];
  if (row.source === "note") {
    // A note keeps its body and refs as JSON: the brief gets them as plain facts.
    const d = noteDetail(row);
    if (d.body) lines.push(`Facts: ${d.body}`);
    if (d.refs.length) lines.push(`Refs: ${d.refs.join(", ")}`);
  } else if (row.detail) lines.push(`Facts: ${row.detail}`);
  if (row.url) lines.push(`Link: ${row.url}`);
  lines.push(`Done when: ${fill(t.doneWhen)}.`);
  return lines.join("\n");
}
