// Commitments: follow-ups someone promised ("I'll check the deploy tomorrow"), stored in the
// ledger with a due time. AI only EXTRACTS them (a worker calls `commitment_add`, or the operator
// types /remind); the engine schedules and delivers the check-in deterministically on the heartbeat
// (proactive.ts) — spec item 13 of docs/superpowers/specs/2026-07-23-hermes-openclaw-upgrades-design.md.
// Everything here is pure or a thin ledger wrapper: no AI, no clock reads the caller didn't pass in.
import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Commitment, CommitmentSource, Ledger } from "./ledger";
import { scanMemoryText } from "./memory";
import { humanAge } from "./session-status";

/** Hard cap on a commitment's text — a one-line promise, not a document. Keeps the heartbeat's
 *  digest (which lists every open commitment) small. A shape limit, not a tuning knob. */
export const COMMITMENT_MAX_CHARS = 280;

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** Local-time instant for `day` (a Date at any time that day) at `hour`:00. */
function atLocalHour(day: Date, hour: number): number {
  const d = new Date(day);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * Parse a due spec into an epoch-ms instant, deterministically from `now`. Accepts:
 *   "30m" · "2h" · "3d" · "1w" (optionally prefixed "in ")  → now + duration
 *   "tomorrow"                                              → tomorrow at `morningHour`:00 local
 *   "2026-10-05"                                            → that day at `morningHour`:00 local
 *   "2026-10-05T14:30" / any full ISO datetime              → that instant
 * Returns undefined for anything else, or for an instant that isn't in the future.
 * `morningHour` is the heartbeat's active-hours start, so a date-only promise lands when the
 * operator is awake.
 */
export function parseDue(spec: string, now: number, morningHour: number): number | undefined {
  const s = spec.trim().toLowerCase().replace(/^in\s+/, "");
  let at: number | undefined;
  const rel = s.match(/^(\d+)\s*([mhdw])$/);
  if (rel) at = now + Number(rel[1]) * UNIT_MS[rel[2]];
  else if (s === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    at = atLocalHour(d, morningHour);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const day = new Date(y, m - 1, d);
    if (day.getFullYear() === y && day.getMonth() === m - 1 && day.getDate() === d) at = atLocalHour(day, morningHour);
  } else if (/^\d{4}-\d{2}-\d{2}t/.test(s)) {
    const t = Date.parse(spec.trim());
    if (Number.isFinite(t)) at = t;
  }
  return at !== undefined && at > now ? at : undefined;
}

/** Validate a commitment's text: one line, bounded, and clean under the memory write-time scan
 *  (the text is later shown to the heartbeat worker, so it gets the same poisoning guard as memory). */
export function checkCommitmentText(text: string): string | undefined {
  const t = text.trim();
  if (!t) return "commitment text is empty";
  if (t.length > COMMITMENT_MAX_CHARS) return `commitment text is over ${COMMITMENT_MAX_CHARS} chars — keep it to one line`;
  if (/[\r\n]/.test(t)) return "commitment text must be one line";
  return scanMemoryText(t);
}

/** Open commitments whose check-in is due NOW: past due, and either never checked in on or last
 *  checked in at least `repeatMs` ago (so an overdue promise re-pings on a slow cadence, not every
 *  heartbeat). */
export function dueCheckins(open: Commitment[], now: number, repeatMs: number): Commitment[] {
  return open.filter(
    (c) => c.status === "open" && c.dueAt <= now && (c.lastCheckinAt === undefined || now - c.lastCheckinAt >= repeatMs),
  );
}

/** Relative due phrase: "due in 3h" / "due 2d ago". */
export function dueLabel(c: Commitment, now: number): string {
  return c.dueAt > now ? `due in ${humanAge(c.dueAt - now)}` : `due ${humanAge(now - c.dueAt)} ago`;
}

/** The operator-facing check-in line the heartbeat delivers for one due commitment. */
export function formatCheckin(c: Commitment, now: number): string {
  return `⏰ Check-in #${c.id}: ${c.text} (${dueLabel(c, now)}). Close it with /commitments done ${c.id}`;
}

/** A compact list of commitments, one per line, soonest first. */
export function formatCommitments(list: Commitment[], now: number): string {
  if (list.length === 0) return "No open commitments.";
  return list.map((c) => `#${c.id} · ${c.project} · ${c.text} — ${dueLabel(c, now)}`).join("\n");
}

/** Record a commitment after validating its text and due spec. Shared by /remind and the tool. */
export function recordCommitment(
  ledger: Pick<Ledger, "addCommitment">,
  input: { text: string; due: string; project: string; source: CommitmentSource; now: number; morningHour: number },
): { ok: true; commitment: Commitment } | { ok: false; error: string } {
  const bad = checkCommitmentText(input.text);
  if (bad) return { ok: false, error: bad };
  const dueAt = parseDue(input.due, input.now, input.morningHour);
  if (dueAt === undefined) {
    return {
      ok: false,
      error: `can't read due "${input.due}" — use 30m / 2h / 3d / 1w, "tomorrow", YYYY-MM-DD, or an ISO datetime in the future`,
    };
  }
  return {
    ok: true,
    commitment: ledger.addCommitment({ text: input.text.trim(), project: input.project, dueAt, source: input.source, at: input.now }),
  };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/**
 * The worker-facing commitment tools, attached to OPERATOR sessions only (neoMcpServers with
 * `commitments` set — the customer/ingress path never passes it). They live on the `neo` MCP
 * server, so the governor allows them like the other first-party tools. `project` is the
 * session's own project tag: a worker can only file commitments under the project it runs in.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function commitmentTools(
  ledger: Pick<Ledger, "addCommitment" | "listCommitments" | "getCommitment" | "setCommitmentStatus">,
  opts: { project: string; morningHour: number; now?: () => number },
): SdkMcpToolDefinition<any>[] {
  const now = opts.now ?? Date.now;
  return [
    tool(
      "commitment_add",
      "Record a follow-up that you or the operator committed to (e.g. \"I'll check the deploy tomorrow\", \"remind me to call the bank on Friday\"). Neo's heartbeat checks in with the operator when it falls due. Only record explicit, concrete promises — not vague intentions. `due` is relative (30m, 2h, 3d, 1w), \"tomorrow\", a date (YYYY-MM-DD), or an ISO datetime.",
      {
        text: z.string().describe("one line: what was promised"),
        due: z.string().describe('when to check in: "2h", "3d", "tomorrow", "2026-10-07", or an ISO datetime'),
      },
      async (args: { text: string; due: string }) => {
        const r = recordCommitment(ledger, { ...args, project: opts.project, source: "worker", now: now(), morningHour: opts.morningHour });
        return text(r.ok ? `recorded #${r.commitment.id} — ${dueLabel(r.commitment, now())}` : `not recorded: ${r.error}`);
      },
    ),
    tool("commitment_list", "List the open commitments (follow-ups Neo will check in on), soonest due first.", {}, async () =>
      text(formatCommitments(ledger.listCommitments("open"), now())),
    ),
    tool(
      "commitment_done",
      "Mark a commitment as done once it has actually been followed up, so Neo stops checking in on it.",
      { id: z.number().int().describe("the commitment id from commitment_list") },
      async (args: { id: number }) => {
        const c = ledger.getCommitment(args.id);
        if (!c || c.status !== "open") return text(`no open commitment #${args.id}`);
        ledger.setCommitmentStatus(args.id, "done");
        return text(`closed #${args.id}`);
      },
    ),
  ];
}
