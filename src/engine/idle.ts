// Idle-close: background SDK sessions are kept warm for follow-ups, but a session that
// has gone quiet should not hold the subscription pool open forever. This sweep closes
// sessions idle past a threshold, persisting their SDK session id so a later message can
// resume the conversation. Pure + clock-injected (no real timers) so it tests deterministically;
// the daemon drives it on a setInterval.
import type { SessionInfo } from "../types";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import { writeIdleStateNote } from "./context-policy";

/** Close every OPEN session whose last activity is older than `idleMs`. Returns those closed.
 *  `writeStateNote` (injectable; defaults to the HANDOFF.md writer) drops a short where-it-left-off
 *  note into each closed session's folder so the next run can resume knowing what was outstanding. */
export function sweepIdle(
  registry: Registry,
  ledger: Ledger,
  opts: { idleMs: number; now: number; writeStateNote?: (s: SessionInfo) => void },
): SessionInfo[] {
  const { idleMs, now } = opts;
  const writeStateNote = opts.writeStateNote ?? writeIdleStateNote;
  const closed: SessionInfo[] = [];

  for (const s of registry.list()) {
    if (s.id === registry.getDefault()?.id) continue; // the company is always-on — never close it
    const open = s.status === "running" || s.status === "idle";
    if (!open) {
      // Terminal leftovers ("error"/"done") have no live run to close — but left registered they
      // block name reuse and accumulate as zombies. Reap them silently (not counted as "closed").
      if (s.sdkSessionId) ledger.recordSession(s.id, s.sdkSessionId);
      registry.remove(s.id);
      continue;
    }
    if (now - s.lastActivityAt <= idleMs) continue;

    // Before ending an unused session, record where it left off so the next run can resume knowing
    // what was outstanding (deterministic engine note; never throws — see writeIdleStateNote).
    writeStateNote(s);
    void registry.getControl(s.id)?.interrupt(); // ends the run; `done` resolves downstream
    if (s.sdkSessionId) ledger.recordSession(s.id, s.sdkSessionId); // keep the resume target
    registry.setStatus(s.id, "done");
    registry.remove(s.id);
    closed.push(s);
  }

  return closed;
}
