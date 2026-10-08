// The todo retry rule (ADR-0027). Pure: no I/O, no clock of its own. The queue is its only caller.
// A run that ends badly carries a `failure` reason from dispatch (or `restart` from boot recovery).
// The reason, never the result text, decides whether the todo is retried: an outside cause that a
// later run can get past is transient; anything else is a task failure and stays `failed`.

/** API error kinds (the SDK's SDKAssistantMessageError) that a re-run cannot fix. Every other kind —
 *  auth, subscription access, billing, rate limit, overload, server error, unknown — can pass. */
const PERMANENT_API = new Set(["invalid_request", "model_not_found", "max_output_tokens"]);

/** Engine-side reasons a run stopped before its work was done (see TodoEnd.failure in dispatch). */
const TRANSIENT = new Set(["stall", "reload", "restart", "checkpoint", "launch"]);

export type EndClass = { transient: true; reason: string } | { transient: false };

/** Classify a bad end by its reason: `stall`, `reload`, `restart`, `checkpoint`, `launch`, or
 *  `api:<kind>`. No reason (the worker reported failure, or `/kill`) is a task failure. */
export function classifyEnd(failure: string | undefined): EndClass {
  if (!failure) return { transient: false };
  if (TRANSIENT.has(failure)) return { transient: true, reason: failure };
  if (failure.startsWith("api:") && failure.length > 4 && !PERMANENT_API.has(failure.slice(4))) return { transient: true, reason: failure };
  return { transient: false };
}

/** When the next retry is due after `attempts` retries so far, or undefined when the ladder is used up
 *  (park the todo as `failed`). The ladder's length is the number of automatic retries. */
export function nextRetry(attempts: number, ladderMs: readonly number[], now: number): { retryAt: number } | undefined {
  const wait = ladderMs[attempts];
  return wait === undefined ? undefined : { retryAt: now + wait };
}

/** The first words of every retry brief — fixed, so a reader (or a test) can tell a retry run. */
export const RETRY_PREAMBLE_MARK = "RETRY of a todo that stopped before it finished";

/** The brief a todo that ran before gets: a fixed preamble, then the stored brief unchanged. `attempts`
 *  is the number of automatic retries so far (1 = this is the second run; 0 = the operator re-ran a
 *  failed todo); `max` the number of automatic retries. */
export function retryBrief(t: { brief: string; attempts: number; result?: string }, max: number): string {
  const which = t.attempts > 0 ? `attempt ${t.attempts + 1} of ${max + 1}` : "re-run on request";
  return (
    `${RETRY_PREAMBLE_MARK} (${which}). ` +
    `The last run stopped: ${t.result?.trim() || "no reason recorded"}. ` +
    "Work is not idempotent: first check what is already done (git log, git status, uncommitted changes, " +
    "worktrees, the files the task touches) and continue from there. Do not repeat finished steps — " +
    "commits, pushes, migrations, deploys or messages. The original brief follows.\n\n" +
    t.brief
  );
}
