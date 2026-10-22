/** Project notes (ADR-0043): one project tells another something through the engine. A note is an
 *  attention item on the TARGET project (source `note`), so the dashboard, digest, console, snooze,
 *  dismiss and → todo work for it unchanged. This module holds the note's own rules: who may send
 *  what to whom (addressing, sizes, secrets, caps), the notes block a fresh session starts with, and
 *  how a note closes — from facts the engine can check (a commit on a branch, a todo that ended done),
 *  never from AI. No note starts work: only the operator's → todo does. */

/** The limits (config `notes`). Every value is positive; a bad one keeps the default. */
export interface NotesCfg {
  maxTitleChars: number;
  maxBodyChars: number;
  maxRefs: number;
  maxRefChars: number;
  maxReasonChars: number;
  /** Notes one sender may raise in 24 hours. */
  maxPerSenderPerDay: number;
  /** Open notes one sender may have to one target. */
  maxOpenPerPair: number;
  /** The notes block: at most this many lines per part, and this many characters in all. */
  blockMax: number;
  blockMaxChars: number;
  /** The sender's part of the block shows notes resolved this many days back. */
  sentLookbackDays: number;
  /** `list`: at most this many lines. */
  listMax: number;
  /** Resolved notes are deleted this long after they resolved (a dismissed one is kept). */
  keepResolvedDays: number;
  /** The bound on each git read of a `resolve … fixed <commit>`. */
  gitTimeoutMs: number;
}

export const DEFAULT_NOTES_CFG: NotesCfg = {
  maxTitleChars: 120, maxBodyChars: 4000, maxRefs: 10, maxRefChars: 200, maxReasonChars: 500,
  maxPerSenderPerDay: 30, maxOpenPerPair: 50, blockMax: 8, blockMaxChars: 1500, sentLookbackDays: 14,
  listMax: 30, keepResolvedDays: 180, gitTimeoutMs: 10_000,
};

/** Config `notes` from config.json: each positive finite number is kept, anything else is the default. */
export function readNotesCfg(raw: unknown): NotesCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_NOTES_CFG };
  for (const k of Object.keys(out) as Array<keyof NotesCfg>) {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}
