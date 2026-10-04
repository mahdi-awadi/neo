// The heartbeat + morning brief (Phase 5, spec items 12-13 of
// docs/superpowers/specs/2026-07-23-hermes-openclaw-upgrades-design.md). Two built-in loops on the
// company workspace, run through the existing loop runtime, with a SILENCE CONTRACT: the worker
// answers `HEARTBEAT_OK` when nothing needs the operator, and the engine drops that reply, so Neo
// only speaks when something matters.
//
// Engine vs AI split (no AI in the engine):
//   - the ENGINE gathers the pending state (open commitments, live sessions, inbox counts), delivers
//     due commitment check-ins itself, gates by active hours, and skips the worker entirely when
//     nothing changed since the last review — so an idle day costs zero worker runs;
//   - the WORKER (read-only: READONLY_DENY) only judges whether any of it needs the operator now.
// Customer text never enters the digest: the inbox contributes counts and ages only, so a tooled
// Claude worker never reads customer-authored content (the compliance firewall's taint rule).
import { createHash } from "node:crypto";
import type { Commitment, Ledger } from "./ledger";
import type { LoopOutcome } from "./loop-runner";
import { sessionStatuses, type SessionStatusView } from "./session-status";
import type { Registry } from "./registry";
import type { Inbox } from "./inbox";
import type { HeartbeatCfg } from "../config";
import { dueCheckins, dueLabel, formatCheckin } from "./commitments";
import { humanAge } from "./session-status";

/** The silence sentinel. A reply that STARTS with it is dropped (nothing to report). */
export const HEARTBEAT_OK = "HEARTBEAT_OK";

/** Event-log kind recording the digest fingerprint of the last heartbeat the worker reviewed. */
export const HEARTBEAT_DIGEST_EVENT = "heartbeat.digest";

export type ProactiveKind = "heartbeat" | "brief";

/** Is `now` inside the operator's active-hours window (local time)? start === end means always;
 *  start > end wraps midnight (22→6 covers 22:00-05:59). */
export function inActiveHours(now: number, hours: HeartbeatCfg["activeHours"]): boolean {
  if (hours.start === hours.end) return true;
  const h = new Date(now).getHours();
  return hours.start < hours.end ? h >= hours.start && h < hours.end : h >= hours.start || h < hours.end;
}

/**
 * Apply the silence contract to the worker's final reply. Returns undefined when the operator
 * should hear nothing: an empty reply, or one that STARTS with HEARTBEAT_OK (the worker said
 * "nothing to report"; anything it tacked on after is chatter). A substantive reply that merely
 * mentions the sentinel elsewhere is delivered with the sentinel stripped.
 */
export function silenceFilter(text: string | undefined): string | undefined {
  const t = (text ?? "").trim();
  if (!t || t.startsWith(HEARTBEAT_OK)) return undefined;
  const cleaned = t.split(HEARTBEAT_OK).join("").trim();
  return cleaned || undefined;
}

/** What the engine knows is pending, gathered deterministically at fire time. */
export interface ProactiveSnapshot {
  commitments: Commitment[];
  sessions: SessionStatusView[];
  /** Customer inbox items waiting on the operator — counts and ages ONLY, never customer text. */
  inbox: { awaiting: number; oldestAt?: number };
}

/** True when there is nothing at all for a heartbeat to review. */
export function snapshotEmpty(s: ProactiveSnapshot): boolean {
  return s.commitments.length === 0 && s.sessions.length === 0 && s.inbox.awaiting === 0;
}

/** A stable fingerprint of the snapshot: which commitments are open (and which are overdue), which
 *  projects are in which state, and how many inbox items wait. Ages and timestamps are left out,
 *  so the fingerprint only changes when the SITUATION changes, not when the clock moves. */
export function snapshotFingerprint(s: ProactiveSnapshot, now: number): string {
  const shape = {
    c: s.commitments.map((c) => [c.id, c.dueAt <= now]),
    s: s.sessions.map((v) => [v.name, v.status]).sort(),
    i: s.inbox.awaiting,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/** The digest the worker reads: one section per source, plain text. */
export function renderDigest(s: ProactiveSnapshot, now: number): string {
  const lines: string[] = ["Open commitments:"];
  if (s.commitments.length === 0) lines.push("- none");
  for (const c of s.commitments) lines.push(`- #${c.id} (${c.project}) ${c.text} — ${dueLabel(c, now)}`);
  lines.push("", "Projects open right now:");
  if (s.sessions.length === 0) lines.push("- none");
  for (const v of s.sessions) lines.push(`- ${v.name} — ${v.line}`);
  lines.push(
    "",
    s.inbox.awaiting === 0
      ? "Customer inbox: nothing waiting on the operator."
      : `Customer inbox: ${s.inbox.awaiting} message(s) waiting on the operator` +
          (s.inbox.oldestAt !== undefined ? ` (oldest ${humanAge(Math.max(0, now - s.inbox.oldestAt))})` : "") +
          ". Content is withheld from you by design; the operator reviews it in /inbox.",
  );
  return lines.join("\n");
}

function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The worker prompt for one heartbeat or brief. Dates and paths are computed by the engine. */
export function proactivePrompt(kind: ProactiveKind, digest: string, now: number): string {
  const today = localDate(now);
  const yesterday = localDate(now - 86_400_000);
  const head =
    kind === "heartbeat"
      ? "You are Neo's heartbeat: a quick, READ-ONLY check of what is pending for the operator (Neo). You can read files but cannot edit them or run commands."
      : "You are writing Neo's morning brief for the operator (Neo). This is READ-ONLY: you can read files but cannot edit them or run commands.";
  const task =
    kind === "heartbeat"
      ? [
          "Decide whether anything here needs the operator's attention NOW: something stuck or failing, a deadline about to slip, a customer waiting too long. Due commitment check-ins have already been sent by the engine, so don't repeat them.",
          `If nothing needs attention, reply with exactly ${HEARTBEAT_OK} and nothing else. Otherwise reply with at most 3 short lines: what needs attention and the next step.`,
        ]
      : [
          "Write a short brief, at most 8 lines: what is due or overdue today, what is running or waiting, anything from yesterday worth carrying forward, and the single most important next step.",
          `If there is genuinely nothing worth saying, reply with exactly ${HEARTBEAT_OK} and nothing else.`,
        ];
  return [
    head,
    `Current local time: ${new Date(now).toString()}.`,
    "",
    "Pending, as recorded by the engine:",
    digest,
    "",
    `For context you may read memory/MEMORY.md, memory/USER.md, memory/log/${today}.md and memory/log/${yesterday}.md in this workspace if they exist.`,
    "",
    ...task,
    "Only your final message reaches the operator; be plain and brief.",
  ].join("\n");
}

/** The ledger slice the proactive loops use. */
export type ProactiveLedger = Pick<Ledger, "listCommitments" | "markCommitmentCheckin" | "recordEvent" | "listEvents">;

/** Live engine state the daemon exposes to the proactive loops (read at fire time). */
export interface ProactiveSources {
  ledger: ProactiveLedger;
  /** Open project sessions, company excluded (session-status.ts sessionStatuses). */
  sessions: () => SessionStatusView[];
  /** Inbox items waiting on the operator — counts and ages only. */
  inbox?: () => { awaiting: number; oldestAt?: number };
}

/** Build the live sources from the engine's own stores. The inbox contributes only items still
 *  waiting on the operator ("new" or "drafted"), as a count plus the oldest arrival time. */
export function makeProactiveSources(
  ledger: ProactiveLedger,
  registry: Registry,
  inbox?: Pick<Inbox, "list">,
  now: () => number = Date.now,
): ProactiveSources {
  return {
    ledger,
    sessions: () => sessionStatuses(registry, now()),
    inbox: inbox
      ? () => {
          const waiting = inbox.list(Number.MAX_SAFE_INTEGER).filter((i) => i.status === "new" || i.status === "drafted");
          return { awaiting: waiting.length, oldestAt: waiting.reduce<number | undefined>((m, i) => (m === undefined || i.receivedAt < m ? i.receivedAt : m), undefined) };
        }
      : undefined,
  };
}

export interface ProactiveDeps {
  sources: ProactiveSources;
  cfg: HeartbeatCfg;
  /** Deliver one line to the operator. */
  reply: (text: string) => void | Promise<void>;
  /** Run the worker once with this prompt, forwarding its text to onMessage. Wired by loops.ts to
   *  runProjectLoop (fresh, read-only, escalations auto-denied). */
  execute: (prompt: string, onMessage: (text: string) => void) => Promise<LoopOutcome>;
  now?: () => number;
  /** Operator asked for it explicitly (/loop heartbeat): ignore active hours and the
   *  unchanged-digest skip, and always run the worker. */
  force?: boolean;
}

const skipped = (detail: string): LoopOutcome => ({ met: false, iterations: 0, reason: "stopped", lastDetail: detail, spentUsd: 0 });

/**
 * One heartbeat or brief fire:
 *  1. heartbeat only: outside active hours → nothing at all (check-ins wait for the window too);
 *  2. deliver every due commitment check-in (engine-side, deterministic) and stamp it;
 *  3. heartbeat only: nothing pending, or the same situation the worker already reviewed → skip
 *     the worker (zero cost, silent);
 *  4. run the read-only worker and deliver its FINAL message through the silence contract.
 */
export async function runProactive(kind: ProactiveKind, deps: ProactiveDeps): Promise<LoopOutcome> {
  const now = (deps.now ?? Date.now)();
  if (kind === "heartbeat" && !deps.force && !inActiveHours(now, deps.cfg.activeHours)) return skipped("outside active hours");

  const { ledger } = deps.sources;
  const open = ledger.listCommitments("open");
  for (const c of dueCheckins(open, now, deps.cfg.checkinRepeatHours * 3_600_000)) {
    await deps.reply(formatCheckin(c, now));
    ledger.markCommitmentCheckin(c.id, now);
  }

  const snap: ProactiveSnapshot = {
    commitments: open,
    sessions: deps.sources.sessions(),
    inbox: deps.sources.inbox?.() ?? { awaiting: 0 },
  };
  if (kind === "heartbeat" && !deps.force) {
    if (snapshotEmpty(snap)) return skipped("nothing pending");
    const fp = snapshotFingerprint(snap, now);
    const last = ledger.listEvents({ kind: HEARTBEAT_DIGEST_EVENT, limit: 1 })[0]?.data?.fp;
    if (last === fp) return skipped("nothing changed since the last review");
    ledger.recordEvent(HEARTBEAT_DIGEST_EVENT, { at: now, data: { fp } });
  }

  const texts: string[] = [];
  const out = await deps.execute(proactivePrompt(kind, renderDigest(snap, now), now), (t) => {
    if (t.trim()) texts.push(t);
  });
  const say = silenceFilter(texts.at(-1));
  if (say) await deps.reply(say);
  return { ...out, lastDetail: say ? "reported" : "silent" };
}
