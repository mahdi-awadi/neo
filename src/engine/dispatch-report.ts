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
import type { Ledger } from "./ledger";
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
 *  the report. */
export interface DispatcherLink {
  deliver(text: string, opts: { wake: boolean }): boolean | Promise<boolean>;
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

/** The final-result text the dispatcher receives. */
export function dispatchResultText(p: { project: string; ok: boolean; summary: string; stop?: StopPoint }): string {
  const head = `[dispatch result] ${p.project}: ${p.summary || (p.ok ? "done" : "failed")}`;
  const stop = p.stop ? formatStopPoint(p.stop) : "";
  return stop ? `${head}\n${stop}` : head;
}

/** The default link: a follow-up into the company's LIVE control. It cannot wake an idle company
 *  (that needs the pipeline — see pipeline.ts `deliverToCompany`), and it refuses a closing control
 *  or a draining engine, where a pushed follow-up would be lost. */
export function liveCompanyLink(registry: Registry, lifecycle?: { draining(): boolean }): DispatcherLink {
  return {
    deliver(text) {
      if (lifecycle?.draining()) return false;
      const company = registry.getDefault();
      const control = company ? registry.getControl(company.id) : undefined;
      if (!control || control.closed?.() === true) return false;
      control.followUp(text);
      return true;
    },
  };
}

/** Deliver every pending inbox report in one message (oldest first). Rows are marked delivered
 *  BEFORE the attempt — so a concurrent flush can't send them twice — and put back on failure. */
export async function flushDispatcherInbox(ledger: Ledger, link: DispatcherLink, now: number): Promise<boolean> {
  const pending = ledger.pendingDispatcherReports();
  if (pending.length === 0) return true;
  const ids = pending.map((r) => r.id);
  ledger.setDispatcherReportsDelivered(ids, now);
  let ok = false;
  try {
    ok = await link.deliver(pending.map((r) => r.text).join("\n\n"), { wake: true });
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
    });
    // Read at boot, so it is the folder's HEAD NOW — a later run may have moved it past this one.
    const head = run.folder ? readCommit(run.folder) : undefined;
    const text =
      dispatchResultText({
        project,
        ok: false,
        summary: "interrupted by an engine restart before it finished — resume it from where it stopped",
      }) + (head ? `\nstopped at — folder HEAD now: ${head}` : "");
    ledger.queueDispatcherReport(project, text, opts.now);
  }
  return runs.length;
}
