// A per-session sliding-window limit (ADR-0066): `remember` (saves per hour) and the worker `history_search`
// (searches per minute) count each session's recent calls. Each call drops the sessions with nothing left in
// the window, so the map holds only sessions that are active now. Pure; in memory (a restart starts empty).

export interface SessionLimiter {
  /** Whether `session` may make one more call at `at`. */
  allow(session: string, at: number): boolean;
  /** Count one call of `session` at `at`. */
  record(session: string, at: number): void;
  /** Sessions held now (tests). */
  size(): number;
}

export function createSessionLimiter(limit: number, windowMs: number): SessionLimiter {
  const calls = new Map<string, number[]>();
  const prune = (at: number): void => {
    for (const [s, times] of calls) {
      const kept = times.filter((t) => at - t < windowMs);
      if (kept.length) calls.set(s, kept);
      else calls.delete(s);
    }
  };
  return {
    allow(session, at) {
      prune(at);
      return (calls.get(session)?.length ?? 0) < limit;
    },
    record(session, at) {
      prune(at);
      calls.set(session, [...(calls.get(session) ?? []), at]);
    },
    size: () => calls.size,
  };
}
