// The engine's self-health check (ADR-0010): event-loop lag (timer drift), resident memory, and a
// `SELECT 1` on the ledger, sampled on an interval. Each metric reports ONCE when it crosses its
// threshold and once when it recovers — a degraded engine is announced, never repeated every minute.
export interface HealthCfg {
  /** How often the daemon samples. 0 turns the check off. */
  everyMs: number;
  /** Event-loop lag (how late the sample timer fired) above which the engine is degraded. */
  lagWarnMs: number;
  /** Resident memory (MB) above which the engine is degraded. */
  rssWarnMb: number;
}

export interface HealthMonitor {
  /** One sample. `lagMs` = how late the timer that called this fired. Never throws. */
  sample(s: { lagMs: number }): void;
}

type Metric = "lag" | "memory" | "ledger";

export function createHealthMonitor(d: {
  cfg: () => HealthCfg;
  rssBytes: () => number;
  /** Throws when the ledger cannot be read. */
  dbPing: () => void;
  report: (text: string) => void;
}): HealthMonitor {
  const degraded = new Set<Metric>();
  const note = (m: Metric, bad: string | undefined, label: string) => {
    if (bad && !degraded.has(m)) {
      degraded.add(m);
      try {
        d.report(`🩺 engine degraded — ${bad}`);
      } catch {
        // reporting is best-effort
      }
    } else if (!bad && degraded.has(m)) {
      degraded.delete(m);
      try {
        d.report(`🩺 engine ${label} recovered`);
      } catch {
        // reporting is best-effort
      }
    }
  };
  return {
    sample({ lagMs }) {
      const cfg = d.cfg();
      note("lag", lagMs > cfg.lagWarnMs ? `event-loop lag ${Math.round(lagMs)}ms (limit ${cfg.lagWarnMs}ms)` : undefined, "event-loop lag");
      let mb: number | undefined;
      try {
        mb = Math.round(d.rssBytes() / (1024 * 1024));
      } catch {
        mb = undefined;
      }
      if (mb !== undefined) note("memory", mb > cfg.rssWarnMb ? `memory ${mb} MB resident (limit ${cfg.rssWarnMb} MB)` : undefined, "memory");
      let dbErr: string | undefined;
      try {
        d.dbPing();
      } catch (e) {
        dbErr = `ledger unreachable: ${e instanceof Error ? e.message : String(e)}`;
      }
      note("ledger", dbErr, "ledger");
    },
  };
}

/** Sample `monitor` every `everyMs` (0 = off). Lag = how late the timer fired versus when it was due,
 *  which is the event loop's delay. The timer is unref'd so it never holds the process open. Returns
 *  a stop function. */
export function startHealthTimer(
  monitor: HealthMonitor,
  everyMs: number,
  t: { now?: () => number; setInterval?: (fn: () => void, ms: number) => unknown; clearInterval?: (h: unknown) => void } = {},
): () => void {
  if (everyMs <= 0) return () => {};
  const now = t.now ?? Date.now;
  const every = t.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear = t.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let due = now() + everyMs;
  const h = every(() => {
    const at = now();
    const lagMs = Math.max(0, at - due);
    due = at + everyMs;
    monitor.sample({ lagMs });
  }, everyMs);
  (h as { unref?: () => void })?.unref?.();
  return () => clear(h);
}
