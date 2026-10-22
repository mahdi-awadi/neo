/** Project notes (ADR-0043): one project tells another something through the engine. A note is an
 *  attention item on the TARGET project (source `note`), so the dashboard, digest, console, snooze,
 *  dismiss and → todo work for it unchanged. This module holds the note's own rules: who may send
 *  what to whom (addressing, sizes, secrets, caps), the notes block a fresh session starts with, and
 *  how a note closes — from facts the engine can check (a commit on a branch, a todo that ended done),
 *  never from AI. No note starts work: only the operator's → todo does. */

import { isAbsolute, join } from "node:path";
import type { AttentionRow, AttentionSeverity, Cause, Ledger } from "./ledger";
import type { Trace } from "./trace";
import { raise } from "./attention";
import { DESKS_DIR, resolveProject } from "./dispatch";
import { findSecret } from "./secret-patterns";

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

export type NoteKind = "finding" | "fyi" | "request";
export const NOTE_KINDS: readonly NoteKind[] = ["finding", "fyi", "request"];
const SEVERITIES: readonly AttentionSeverity[] = ["high", "normal", "low"];
const DAY_MS = 86_400_000;

/** What a worker sends. The sender is never part of it: the engine takes it from the session. */
export interface NoteInput {
  to: string;
  kind: NoteKind;
  severity: AttentionSeverity;
  title: string;
  body: string;
  refs?: string[];
  /** The sender's own id for the note (`D16`): the same ref again refreshes the same note. */
  ref: string;
}

/** The session that calls the tool: its project name, folder, reply chat and current cause. */
export interface SenderCtx {
  project: string;
  folder: string;
  chatId: number;
  cause?: Cause;
}

export interface NoteResult {
  ok: boolean;
  text: string;
  id?: number;
}

export interface NotesDeps {
  ledger: Ledger;
  cfg: NotesCfg;
  /** Where project folders live (config workRoot); a target must be a folder directly under it. */
  workRoot: string;
  /** The desks folder: a desk is never a note's target. */
  desksDir?: string;
  trace?: Pick<Trace, "outbound">;
  /** Post one line to the operator now (a `request`, or a `high` finding) — see `noteRoute`. */
  notifyNow?: (row: AttentionRow) => void;
}

/** The fixed routing table (AC5): which notes the operator hears about now, which wait for the digest.
 *  No route starts work, enters a session or adds a todo. */
export function noteRoute(kind: NoteKind, severity: AttentionSeverity): "now" | "digest" {
  return kind === "request" || (kind === "finding" && severity === "high") ? "now" : "digest";
}

/** The attention kind a note is stored as (one brief template per kind). */
export const noteAttentionKind = (kind: NoteKind): string => `note_${kind}`;

/** A note's body and refs, as kept in the attention row's `detail`. */
export interface NoteDetail {
  body: string;
  refs: string[];
}
export function noteDetail(row: Pick<AttentionRow, "detail">): NoteDetail {
  try {
    const d = JSON.parse(row.detail ?? "") as Partial<NoteDetail>;
    return { body: typeof d.body === "string" ? d.body : "", refs: Array.isArray(d.refs) ? d.refs.filter((x) => typeof x === "string") : [] };
  } catch {
    return { body: row.detail ?? "", refs: [] };
  }
}

export interface ProjectNotes {
  send(from: SenderCtx, input: NoteInput, now: number): NoteResult;
  /** Delete notes resolved longer ago than `notes.keepResolvedDays` (a dismissed one is kept). */
  prune(now: number): void;
}

export function createProjectNotes(deps: NotesDeps): ProjectNotes {
  const { ledger, cfg } = deps;

  /** The target's folder, or why it is not a valid target. */
  const target = (from: SenderCtx, to: string): { folder: string } | { error: string } => {
    const name = to.trim();
    if (isAbsolute(name) || name.includes("/") || name.includes("\\") || name === "." || name === "..") return { error: "`to` must be a project name, not a path" };
    if (name === from.project) return { error: "a project cannot send a note to itself" };
    const folder = resolveProject(name, deps.workRoot, deps.desksDir ?? DESKS_DIR);
    // resolveProject also finds desks; a note goes only to a project folder directly under the work root.
    if (!folder || folder !== join(deps.workRoot, name)) return { error: `no project named ${name} under ${deps.workRoot}` };
    return { folder };
  };

  const secretIn = (texts: string[]): string | undefined => {
    for (const t of texts) {
      const hit = findSecret(t);
      if (hit) return hit;
    }
    return undefined;
  };

  /** Why `input` cannot be sent (the shape and the content), or undefined. */
  const invalid = (input: NoteInput): string | undefined => {
    const refs = input.refs ?? [];
    if (!NOTE_KINDS.includes(input.kind)) return "kind must be finding, fyi or request";
    if (!SEVERITIES.includes(input.severity)) return "severity must be high, normal or low";
    if (!input.title?.trim()) return "a note needs a title";
    if (!input.ref?.trim()) return "a note needs a ref (your own id for it, e.g. D16)";
    if (input.title.length > cfg.maxTitleChars) return `the title is over ${cfg.maxTitleChars} characters`;
    if ((input.body ?? "").length > cfg.maxBodyChars) return `the body is over ${cfg.maxBodyChars} characters`;
    if (refs.length > cfg.maxRefs) return `more than ${cfg.maxRefs} refs`;
    if (input.ref.length > cfg.maxRefChars || refs.some((r) => r.length > cfg.maxRefChars)) return `a ref is over ${cfg.maxRefChars} characters`;
    const secret = secretIn([input.title, input.body ?? "", input.ref, ...refs]);
    if (secret) return `the note looks like a secret (${secret}) — never send secrets; name where the value lives instead`;
    return undefined;
  };

  const refuse = (from: SenderCtx, to: string, reason: string): NoteResult => {
    ledger.recordEvent("note_refused", { folder: from.folder, cause: from.cause, data: { from: from.project, to, reason } });
    return { ok: false, text: `note not sent: ${reason}` };
  };

  return {
    send(from, input, now) {
      const bad = invalid(input);
      if (bad) return refuse(from, input.to, bad);
      const t = target(from, input.to);
      if ("error" in t) return refuse(from, input.to, t.error);
      const to = input.to.trim();
      const key = `${from.project}:${input.ref.trim()}`;
      const existing = ledger.attentionRows(to, "note").find((r) => r.key === key);
      if (existing?.dismissed) return refuse(from, to, `note #${existing.id} (${input.ref.trim()}) was dismissed by the operator and stays closed`);
      const isNew = !existing;
      const reopens = existing?.resolvedAt !== undefined;
      const counts = ledger.noteCounts(from.project, to, now - DAY_MS);
      if (isNew && counts.sentSince >= cfg.maxPerSenderPerDay) {
        return refuse(from, to, `${from.project} already sent ${counts.sentSince} notes in 24 hours (notes.maxPerSenderPerDay)`);
      }
      if ((isNew || reopens) && counts.openToTarget >= cfg.maxOpenPerPair) {
        return refuse(from, to, `${from.project} already has ${counts.openToTarget} open notes to ${to} (notes.maxOpenPerPair) — resolve or withdraw some first`);
      }
      const refs = input.refs ?? [];
      const id = raise(
        ledger,
        {
          project: to, folder: t.folder, source: "note", kind: noteAttentionKind(input.kind), key,
          title: input.title.trim(), detail: JSON.stringify({ body: input.body ?? "", refs } satisfies NoteDetail),
          severity: input.severity, fromProject: from.project, causeMsgId: from.cause?.msgId,
        },
        now,
      );
      ledger.recordEvent("note_sent", { folder: from.folder, cause: from.cause, data: { id, from: from.project, to, kind: input.kind, severity: input.severity, ref: input.ref.trim() } });
      deps.trace?.outbound({ chatId: from.chatId, text: `note #${id} → ${to}: ${input.title.trim()}`, cause: from.cause, kind: "notice", project: from.project, folder: from.folder });
      if ((isNew || reopens) && noteRoute(input.kind, input.severity) === "now") {
        const row = ledger.attentionById(id);
        if (row) deps.notifyNow?.(row);
      }
      return { ok: true, text: `note #${id} → ${to}`, id };
    },
    prune(now) {
      ledger.pruneAttention("note", now - cfg.keepResolvedDays * DAY_MS);
    },
  };
}
