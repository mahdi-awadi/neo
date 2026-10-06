// Dispatch reporting (ADR-0007): what a running or finished dispatch tells its DISPATCHER (the
// company session) and the operator. Deterministic text built from engine-observed facts — elapsed
// time, current activity, the worker's latest note, the folder's last commit — never AI.
//
// Two channels, two rules:
//   • progress digests are best-effort and live only: delivered into a LIVE company, never waking
//     it, never stored (a stale digest is worthless);
//   • final results are durable: queued in the ledger's dispatcher inbox FIRST, then delivered —
//     waking an idle company — so a reload, a crash or a closed company session cannot lose one.
//     Whatever is still pending rides along with the next delivery, or is prepended to the
//     operator's next message to the company (pipeline.ts).
import { spawnSync } from "node:child_process";
import type { Cause, Ledger } from "./ledger";
import type { Registry } from "./registry";

/** Where an interrupted dispatch stopped — what the dispatcher needs to resume it. */
export interface StopPoint {
  /** `<short sha> <subject> (<relative age>)` of the folder's HEAD. */
  lastCommit?: string;
  /** The worker's latest prose line (never a tool line). */
  lastNote?: string;
  /** The worker's last activity label (e.g. "Agent: Implement Task 6"). */
  lastActivity?: string;
}

/** How the dispatch module reaches the dispatcher. `wake` asks to resume an idle company; a link
 *  that cannot deliver (no live company, draining, reopening) returns false and the caller keeps
 *  the report. `cause` is the thread the report belongs to: the company's turn that reads it is
 *  filed there (spec §3.3, "the result goes back to its thread"). */
export interface DispatcherLink {
  deliver(text: string, opts: { wake: boolean; cause?: Cause }): boolean | Promise<boolean>;
}

/** Max chars of a worker note quoted in a digest / stop point — one line, never a wall of text. */
const NOTE_MAX = 280;
/** Bound on the `git log` read — it must never hold up a report. */
const GIT_TIMEOUT_MS = 5_000;

/** The folder's HEAD commit as `<sha> <subject> (<age>)`, or undefined (not a repo, git missing,
 *  timeout). Read-only and bounded. */
export function lastCommitIn(folder: string): string | undefined {
  try {
    const r = spawnSync("git", ["-C", folder, "log", "-1", "--format=%h %s (%cr)"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    const out = r.status === 0 ? r.stdout.trim() : "";
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** One bounded, read-only git query in `folder`; undefined on any failure (not a repo, git missing,
 *  timeout). */
export function git(folder: string, args: string[]): string | undefined {
  try {
    const r = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
    return r.status === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The handoff note is written FOR a reset, so it never counts as uncommitted work (ADR-0021). */
const HANDOFF_NOTE = "HANDOFF.md";

/** Paths with uncommitted changes (modified, staged or untracked), relative to the repo root, minus
 *  this folder's own `HANDOFF.md` (the folder may be a sub-folder of its repo). `[]` = clean;
 *  undefined = not a git repo or git failed. */
export function uncommittedIn(folder: string): string[] | undefined {
  const out = git(folder, ["status", "--porcelain", "--untracked-files=all"]);
  if (out === undefined) return undefined;
  const note = (git(folder, ["rev-parse", "--show-prefix"])?.trim() ?? "") + HANDOFF_NOTE;
  return out
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()!)
    .filter((p) => p !== note);
}

/** Branch, HEAD (`<sha> <subject>`) and uncommitted paths, read from git — the facts a handoff note
 *  must not take from the worker's word. `{}` outside a repo. */
export function gitFacts(folder: string): { branch?: string; head?: string; uncommitted?: string[] } {
  const uncommitted = uncommittedIn(folder);
  if (uncommitted === undefined) return {};
  const branch = git(folder, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || undefined;
  const head = git(folder, ["log", "-1", "--format=%h %s"])?.trim() || undefined;
  return { branch, head, uncommitted };
}

function oneLine(text: string, max = NOTE_MAX): string {
  const first = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

function elapsed(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** One digest line for a running dispatch. Says plainly that no reply is needed, so the dispatcher
 *  does not spend a turn answering it. */
export function progressDigest(p: {
  project: string;
  elapsedMs: number;
  activity?: string;
  lastNote?: string;
  lastCommit?: string;
}): string {
  const parts = [`[dispatch progress] ${p.project} — running ${elapsed(p.elapsedMs)}`];
  if (p.activity) parts.push(`now: ${oneLine(p.activity, 120)}`);
  if (p.lastCommit) parts.push(`last commit: ${oneLine(p.lastCommit, 160)}`);
  if (p.lastNote) parts.push(`latest note: «${oneLine(p.lastNote)}»`);
  return `${parts.join(" · ")} (FYI — no reply needed)`;
}

/** "stopped at — …" for an abnormal end, or "" when nothing is known. */
export function formatStopPoint(s: StopPoint): string {
  const parts: string[] = [];
  if (s.lastCommit) parts.push(`last commit: ${oneLine(s.lastCommit, 160)}`);
  if (s.lastNote) parts.push(`latest note: «${oneLine(s.lastNote)}»`);
  if (s.lastActivity) parts.push(`last activity: ${oneLine(s.lastActivity, 120)}`);
  return parts.length ? `stopped at — ${parts.join(" · ")}` : "";
}

/** The final-result text the dispatcher receives. `ref` (the thread's ref, e.g. `m4g2`) tells the
 *  company which operator thread the result answers: `[dispatch result · m4g2]`. */
export function dispatchResultText(p: { project: string; ok: boolean; summary: string; stop?: StopPoint; ref?: string }): string {
  const head = `[dispatch result${p.ref ? ` · ${p.ref}` : ""}] ${p.project}: ${p.summary || (p.ok ? "done" : "failed")}`;
  const stop = p.stop ? formatStopPoint(p.stop) : "";
  return stop ? `${head}\n${stop}` : head;
}

/** The default link: a follow-up into the company's LIVE control. It cannot wake an idle company
 *  (that needs the pipeline — see pipeline.ts `deliverToCompany`), and it refuses a closing control
 *  or a draining engine, where a pushed follow-up would be lost. */
export function liveCompanyLink(registry: Registry, lifecycle?: { draining(): boolean }): DispatcherLink {
  return {
    deliver(text, opts) {
      if (lifecycle?.draining()) return false;
      const company = registry.getDefault();
      const control = company ? registry.getControl(company.id) : undefined;
      if (!control || control.closed?.() === true) return false;
      if (opts.cause) control.followUp(text, opts.cause);
      else control.followUp(text);
      return true;
    },
  };
}

/** Deliver every pending inbox report in one message (oldest first). Rows are marked delivered
 *  BEFORE the attempt — so a concurrent flush can't send them twice — and put back on failure. The
 *  message carries the newest report's cause (one input has one cause, spec §4.2). */
export async function flushDispatcherInbox(ledger: Ledger, link: DispatcherLink, now: number): Promise<boolean> {
  const pending = ledger.pendingDispatcherReports();
  if (pending.length === 0) return true;
  const ids = pending.map((r) => r.id);
  ledger.setDispatcherReportsDelivered(ids, now);
  let ok = false;
  try {
    const cause = pending.findLast((r) => r.cause)?.cause;
    ok = await link.deliver(pending.map((r) => r.text).join("\n\n"), cause ? { wake: true, cause } : { wake: true });
  } catch {
    ok = false;
  }
  if (!ok) ledger.setDispatcherReportsDelivered(ids, null);
  return ok;
}

/** Take every pending report as one block (marking them delivered) — for prepending to the
 *  operator's next message to the company. Undefined when the inbox is empty. */
export function takeDispatcherInbox(ledger: Ledger, now: number): string | undefined {
  const pending = ledger.pendingDispatcherReports();
  if (pending.length === 0) return undefined;
  ledger.setDispatcherReportsDelivered(
    pending.map((r) => r.id),
    now,
  );
  return pending.map((r) => r.text).join("\n\n");
}

/** Boot-time recovery: a `dispatch_start` with no `dispatch_end` (inside `windowMs`) is a run the
 *  daemon died or was reloaded during. Record its missing end and queue a result with its stop
 *  point, so the dispatcher learns it was cut short and where. Idempotent. Returns how many. */
export function recoverInterruptedDispatches(
  ledger: Ledger,
  opts: { now: number; windowMs: number; lastCommit?: (folder: string) => string | undefined },
): number {
  const readCommit = opts.lastCommit ?? lastCommitIn;
  const runs = ledger.unfinishedDispatches(opts.now - opts.windowMs);
  for (const run of runs) {
    const project = run.project ?? run.folder ?? "dispatch";
    ledger.recordEvent("dispatch_end", {
      orderId: run.orderId,
      folder: run.folder,
      data: { project, ok: false, timedOut: false, interrupted: "engine restart" },
      at: opts.now,
      cause: run.cause, // the order's cause: the result goes back to its thread
    });
    // Read at boot, so it is the folder's HEAD NOW — a later run may have moved it past this one.
    const head = run.folder ? readCommit(run.folder) : undefined;
    const text =
      dispatchResultText({
        project,
        ok: false,
        summary: "interrupted by an engine restart before it finished — resume it from where it stopped",
      }) + (head ? `\nstopped at — folder HEAD now: ${head}` : "");
    ledger.queueDispatcherReport(project, text, opts.now, run.cause);
  }
  return runs.length;
}

/** Digests in a row with the same fingerprint before a dispatch counts as spinning (spec §8.1). */
export const DISPATCH_SPIN_DIGESTS_DEFAULT = 3;
/** The same tool call this many times in a row in one turn counts as a loop (spec §8.1). */
export const TOOL_LOOP_LIMIT_DEFAULT = 8;

/** A digest's fingerprint (spec §8.1): the activity label with absolute paths, hex runs and numbers
 *  replaced by `#`, the latest note and the HEAD line. Two equal fingerprints: the worker was
 *  active, but nothing it reports has changed. */
export function digestFingerprint(label: string | undefined, note: string | undefined, head: string | undefined): string {
  const norm = (label ?? "")
    .replace(/(?:\/[^\s/]+)+\/?/g, "#") // absolute paths
    .replace(/\b[0-9a-f]{7,}\b/gi, "#") // hex runs (shas, ids)
    .replace(/\d+/g, "#")
    .trim();
  return [norm, note ?? "", head ?? ""].join("\u0000");
}

/** Counts repeats, no AI (spec §8.1). `digest`: spinning once when the same fingerprint came
 *  `digests` times in a row (`changed`: it differs from the previous one). `tool`: true once when
 *  the same (tool, input hash) came `toolLoopLimit` times in a row; `turnEnd` resets that count. */
export function createSpinWatch(o: { digests: number; toolLoopLimit: number }) {
  let fp: string | undefined;
  let fpCount = 0;
  let fpAlerted = false;
  let call: string | undefined;
  let callCount = 0;
  let callAlerted = false;
  return {
    digest(next: string): { spinning: boolean; changed: boolean } {
      const changed = next !== fp;
      if (changed) (fp = next), (fpCount = 1), (fpAlerted = false);
      else fpCount++;
      const spinning = !fpAlerted && fpCount >= o.digests;
      if (spinning) fpAlerted = true;
      return { spinning, changed };
    },
    tool(name: string, inputHash: string): boolean {
      const k = `${name}\u0000${inputHash}`;
      if (k !== call) (call = k), (callCount = 1), (callAlerted = false);
      else callCount++;
      if (callAlerted || callCount < o.toolLoopLimit) return false;
      return (callAlerted = true);
    },
    turnEnd(): void {
      call = undefined;
      callCount = 0;
      callAlerted = false;
    },
  };
}
