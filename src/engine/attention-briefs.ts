/** One brief template per attention kind (ADR-0018, spec §7 "one tap → todo"): the facts, the URL and
 *  the definition of done the worker gets when the operator taps `→ todo` on an item. Data, not
 *  code paths: a new kind adds one entry (a test checks every producer kind has one). */
import type { AttentionRow } from "./ledger";
import { noteDetail } from "./project-notes";
import { factsOf } from "./attention-facts";

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
  // GitHub (ADR-0059): `{name}` placeholders are the item's facts (attention-facts.ts).
  pr_open: {
    task: "Review PR #{pr} in this project ({prTitle}). Read its diff, its CI and what it changes. A dependency update: merge it when CI is green and the app builds and its tests pass, else close it with the reason. Any other PR: review it, then merge it or comment with what must change.",
    doneWhen: "PR #{pr} is merged, or closed or commented with a stated reason",
  },
  pr_review_requested: {
    task: "PR #{pr} waits for your review ({prTitle}). Read the diff, run its tests, and post a review: approve, or request changes with the reasons.",
    doneWhen: "the review of PR #{pr} is posted",
  },
  ci_failed: {
    task: "CI workflow {workflow} failed on branch {branch}. Read the failing run's log, find the root cause, fix it with a test, and commit the fix.",
    doneWhen: "the cause is fixed and committed, and {workflow} passes on {branch}",
  },
  issue_open: {
    task: "Issue #{issue} is open for this project ({issueTitle}). Reproduce it, fix the cause with a test and commit, or explain why it should be closed.",
    doneWhen: "issue #{issue} is fixed and committed, or the reason to close it is written down",
  },
  dependabot: {
    task: "Dependabot alert #{alert} ({severity}): {summary}. Update the dependency to a fixed version, run the tests and commit; or show why the alert does not apply here.",
    doneWhen: "the dependency is updated and committed, or why it does not apply is written down",
  },
  code_scanning: {
    task: "Code scanning alert #{alert}: {summary}. Check it against the code. If it is real, fix it with a test and commit; if it is a false positive, say why.",
    doneWhen: "the finding is fixed and committed, or shown to be a false positive",
  },
  secret_scanning: {
    task: "A secret leaked in this repository (alert #{alert}, {secretType}). Remove it from the code and the config, and tell the operator to rotate it. Never print the value.",
    doneWhen: "the secret is out of the code and the operator was told to rotate it",
  },
  // Git (ADR-0059).
  unpushed: {
    task: "Branch {branch} is {ahead} commit(s) ahead of {upstream}. Check the commits are finished and the tests are green, then push them.",
    doneWhen: "{branch} is pushed, or why it must not be pushed yet is written down",
  },
  no_upstream: {
    task: "Branch {branch} has no upstream on the remote. If its work is wanted, push it; if it is merged or abandoned, delete it. Say which, and why.",
    doneWhen: "{branch} is pushed or deleted, with the reason",
  },
  stale_branch: {
    task: "Branch {branch} has had no commit for {days} days and is not merged into {base}. Find out what it holds: merge it if it is finished, finish it if it is close, or delete it if it is abandoned. Say which, and why.",
    doneWhen: "{branch} is merged, finished or deleted, with the reason",
  },
  drift: {
    task: "{branch} is {ahead} commit(s) ahead of {base}. Check those commits are ready, then merge {branch} into {base}, or say what blocks it.",
    doneWhen: "{base} has the commits, or what blocks the merge is written down",
  },
  worktree: {
    task: "The worktree {path} has been idle for {hours}h. If its work is committed and merged, remove it (git worktree remove); otherwise commit the work or say what is left in it.",
    doneWhen: "the worktree is removed, or what is left in it is committed or explained",
  },
  // The task history and the snapshot backup (ADR-0067): Neo's own engine; `{step}` is what the operator
  // or a worker does (history/services.ts operatorStep).
  history_off: {
    task: "Meaning search over Neo's task history is off ({service}: {reason}). The step: {step}. Do the part a worker may do (check the service, the config names, the logs; never print a key), and tell the operator exactly what is left for them (a reload, an ops request). Do NOT restart or reload Neo.",
    doneWhen: "meaning search is on again (`bun tools/history/admin.ts status` shows both services up), or the operator has the one step left for them",
  },
  history_degraded: {
    task: "Neo's task history service {service} has been down or slow ({reason}) for a long time. The step: {step}. Find why it does not answer and bring it back without touching other projects' services. Do NOT restart or reload Neo.",
    doneWhen: "`bun tools/history/admin.ts status` shows {service} up, or the cause and the fix are reported",
  },
  backup_failed: {
    task: "The snapshot backup of {path} failed ({reason}). Read docs/backup.md and the reason, fix the cause (free space, a corrupt source, a timeout), and check that the next snapshot works.",
    doneWhen: "the cause is fixed and a new snapshot passes its integrity check, or what blocks it is reported",
  },
  restart_gated: {
    task: "Neo has changes that are built but not running: {title}. Check the change is ready (tests and types green on the branch), then list what a restart activates. Do NOT restart or reload Neo.",
    doneWhen: "the list of what a restart activates is ready for the operator",
  },
};

/** The todo brief for an item: its template, the facts and the URL. Undefined: no template (the
 *  test makes that impossible for a known kind). */
export function attentionBrief(
  row: Pick<AttentionRow, "kind" | "title" | "detail" | "url" | "project"> & Partial<Pick<AttentionRow, "id" | "source" | "fromProject" | "key" | "facts">>,
): string | undefined {
  const t = ATTENTION_BRIEFS[row.kind];
  if (!t) return undefined;
  // `{title}`, `{from}`, `{id}`, then the item's facts by name (ADR-0059); a fact the item does not have reads "?".
  const facts = factsOf({ kind: row.kind, key: row.key ?? "", title: row.title, facts: row.facts });
  // One pass, so a filled value (a title holding "{lang}") is never scanned again.
  const values: Record<string, string | number | undefined> = { ...facts, title: row.title, from: row.fromProject ?? "?", id: row.id ?? "?" };
  const fill = (s: string) => s.replace(/\{([A-Za-z]+)\}/g, (_, k: string) => (values[k] !== undefined && values[k] !== "" ? String(values[k]) : "?"));
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
