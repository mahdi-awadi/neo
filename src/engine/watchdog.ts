// Stuck-watchdog: alert the operator ONCE when a session looks genuinely wrong. Pure +
// clock-injected (the daemon drives it on the 60s tick). Observer only: it never interrupts a
// worker; recovery is /kill.
//
// It judges on the ONE authoritative signal — no ACTIVITY (any streamed SDK event), never on
// "nothing the operator can read". A worker mid-generation writing one huge file is working; a
// session sitting between turns is healthy at any age; a session waiting on the operator is waiting
// on the OPERATOR. Only three things earn an alert, and each states its evidence first:
//   • wedged   — a turn is in flight and nothing has been seen for stuckAfterMs
//   • starting — registered but its worker never attached (a dead prepare step)
//   • long turn — an FYI: still alive, but on the same label past longTurnAlertMs
// See docs/adr/0003-one-activity-clock-one-derived-session-state.md.
import type { SessionInfo } from "../types";
import type { Registry } from "./registry";
import { humanAge } from "./liveness";
import { sessionEvidence } from "./session-status";

export interface WatchdogOpts {
  now: number;
  /** No activity for this long, with a turn in flight → wedged. */
  stuckAfterMs: number;
  /** Same activity label for this long (while still alive) → a long-turn FYI. */
  longTurnAlertMs: number;
  alertRepeatMs: number;
  alert: (s: SessionInfo, reason: string) => void;
  /** Record the evidence behind an alert (the daemon wires ledger.recordEvent). Fired BEFORE the
   *  alert, so a wrong alert is diagnosable from the log alone. */
  record?: (kind: string, data: Record<string, unknown>) => void;
}

/** Alert on sessions that look genuinely wrong (deduped via alertedAt). Returns those alerted. */
export function sweepStuck(registry: Registry, opts: WatchdogOpts): SessionInfo[] {
  const { now, stuckAfterMs, longTurnAlertMs, alertRepeatMs } = opts;
  const alerted: SessionInfo[] = [];
  for (const s of registry.list()) {
    if (s.status !== "running") continue;
    if (s.alertedAt !== undefined && now - s.alertedAt < alertRepeatMs) continue; // dedup window
    // The sweep's own window IS stuckAfterMs, so the state it reads is the state it is deciding on.
    const ev = sessionEvidence(registry, s, now, { wedgedAfterMs: stuckAfterMs, quietAfterMs: Number.MAX_SAFE_INTEGER });
    const stdin = ev.stdinWait ? ` — that command looks like it is waiting on stdin (interactive prompt)` : "";

    let reason: string | undefined;
    if (ev.state === "wedged") {
      reason =
        `${s.name} is wedged: a turn is in flight and there has been no activity for ` +
        `${humanAge(ev.lastActivityMs)}${ev.activity ? ` (last: ${ev.activity})` : ""}${stdin}`;
    } else if (ev.state === "starting" && ev.lastActivityMs >= stuckAfterMs) {
      reason =
        `${s.name} has had no worker attached for ${humanAge(ev.lastActivityMs)} — ` +
        `its start-up (indexing / context gate) never finished`;
    } else if (ev.state !== "idle" && ev.state !== "awaiting-operator" && ev.activityForMs !== undefined && ev.activityForMs >= longTurnAlertMs) {
      // Not a fault claim: it is alive and pulsing, just long. Say so, or the reader "helpfully"
      // restarts a working project.
      reason =
        `${s.name} has been on "${ev.activity}" for ${humanAge(ev.activityForMs)} — ` +
        `still producing activity (last ${humanAge(ev.lastActivityMs)} ago), so this is an FYI, not a stuck session`;
    }
    if (!reason) continue;

    registry.noteAlert(s.id, now);
    try {
      opts.record?.("session_stuck", {
        project: s.name,
        folder: s.order.folder,
        state: ev.state,
        inTurn: ev.inTurn,
        queued: ev.queued,
        lastActivityMs: ev.lastActivityMs,
        lastOutputMs: ev.lastOutputMs,
        activity: ev.activity ?? null,
        activityForMs: ev.activityForMs ?? null,
        stdinWait: ev.stdinWait,
      });
    } catch {
      // observer only — a recording failure must never break the sweep
    }
    try {
      opts.alert(s, `⚠️ ${reason} — reply /kill ${s.name} to abort.`);
    } catch {
      // observer only — an alert-channel failure must never break the sweep
    }
    alerted.push(s);
  }
  return alerted;
}
