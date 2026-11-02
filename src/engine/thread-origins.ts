// Where a thread started (ADR-0016, ADR-0053) — the one list. The ledger types it, the console API
// validates its filter with it, and the console bundle builds its filter from it (no other imports).

export const THREAD_ORIGINS = ["operator", "loop", "attention", "ingress", "dispatcher", "legacy"] as const;

/** `dispatcher`: work the dispatcher started with no live operator message (ADR-0053). */
export type ThreadOrigin = (typeof THREAD_ORIGINS)[number];
