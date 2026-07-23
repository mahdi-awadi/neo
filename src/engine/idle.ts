// Idle-close: background SDK sessions are kept warm for follow-ups, but a session that
// has gone quiet should not hold the subscription pool open forever. This sweep closes
// sessions idle past a threshold, persisting their SDK session id so a later message can
// resume the conversation. Pure + clock-injected (no real timers) so it tests deterministically;
// the daemon drives it on a setInterval.
import type { SessionInfo } from "../types";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { MemoryCfg } from "../config";
import { writeIdleStateNote } from "./context-policy";
import { appendDailyLog, memoryEnabledFor } from "./memory";

/** The deterministic (no worker) one-line summary written to today's memory log when a session is
 *  idle-closed — same "last activity" fact idleStateNote's HANDOFF.md note already surfaces, just
 *  as a single searchable log line rather than a whole overwritten file. */
function idleLogLine(session: SessionInfo): string {
  return `idle-closed: ${session.name} — last activity: ${session.activity?.label || "(unknown)"}`;
}

/** Close every OPEN session whose last activity is older than `idleMs`. Returns those closed.
 *  `writeStateNote` (injectable; defaults to the HANDOFF.md writer) drops a short where-it-left-off
 *  note into each closed session's folder so the next run can resume knowing what was outstanding.
 *  When `memory`+`companyFolder` are set AND the session's folder is in scope (memoryScopeEnabled,
 *  same gate every other memory injection uses), a deterministic engine-written log line is ALSO
 *  appended to today's memory log — in addition to, never instead of, the HANDOFF.md note. Gated
 *  BEFORE calling appendDailyLog so an out-of-scope folder never gets a memory/ dir created. */
export function sweepIdle(
  registry: Registry,
  ledger: Ledger,
  opts: {
    idleMs: number;
    now: number;
    writeStateNote?: (s: SessionInfo) => void;
    memory?: MemoryCfg;
    companyFolder?: string;
  },
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
    if (memoryEnabledFor(opts.memory, s.order.folder, opts.companyFolder)) {
      appendDailyLog(s.order.folder, idleLogLine(s));
    }
    void registry.getControl(s.id)?.interrupt(); // ends the run; `done` resolves downstream
    if (s.sdkSessionId) ledger.recordSession(s.id, s.sdkSessionId); // keep the resume target
    registry.setStatus(s.id, "done");
    registry.remove(s.id);
    closed.push(s);
  }

  return closed;
}
