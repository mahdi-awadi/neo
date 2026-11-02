// The `report` tool's pure core (plan 2026-11-02 W1.1, ADR-0073): a worker's END-OF-WORK CLAIM, as a
// schema the engine validates, never prose the engine reads. The claim is what the worker SAYS
// happened (status, summary, what it ran, what it changed, its reference, risks, assumptions); the
// VERDICT is what the engine assigns after the gate (W1.3/W1.4). This module owns the shape and the
// rules a claim must meet to be recorded; the tool in dispatch.ts records it as an event and tells
// the worker to finish. No I/O here.
import { z } from "zod";

export const CLAIM_STATUSES = ["ready", "blocked", "failed", "dropped", "no_change_needed", "handback"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Bounds a claim must respect (the engine stores it on the dispatch's end and renders it). */
export const CLAIM_LIMITS = { summary: 240, item: 300, items: 20, ran: 40, cmd: 300 } as const;

/** The event kind the tool records; the settle path (W1.3) reads the newest one for its order. */
export const CLAIM_EVENT = "report_claimed";

/** The Zod shape the SDK `tool()` takes (the same style as `ask_operator`). */
export const claimShape = {
  status: z.enum(CLAIM_STATUSES).describe(
    "ready = the deliverable is complete, self-reviewed and its checks passed; blocked = you cannot finish without the operator (say what in `summary`); " +
      "failed = you tried and could not make it work; dropped = nothing to do (not reproducible, superseded); no_change_needed = you verified the code is already right (needs `evidence`); " +
      "handback = this request is outside your brief (needs `handback.reason`)",
  ),
  summary: z.string().describe(`one plain sentence of the user-visible outcome (at most ${CLAIM_LIMITS.summary} characters); no file paths, no commit hashes`),
  ran: z
    .array(z.object({ cmd: z.string().describe("the exact command"), exit: z.number().int().describe("its exit code") }))
    .describe("every check or test command you actually ran, with its exit code (empty if none)"),
  changed: z.array(z.string()).describe("repo-relative paths you changed (empty if none)"),
  ref: z
    .object({
      pr: z.number().int().positive().optional().describe("the real PR number, if you opened one"),
      commit: z.string().optional().describe("the HEAD commit sha of your work, if committed"),
    })
    .nullable()
    .describe("the PR or commit the outcome lives in; null when there is none"),
  risks: z.array(z.string()).describe("what could go wrong or what you are unsure of (empty if none)"),
  assumptions: z.array(z.string()).describe("what you assumed that nobody confirmed (empty if none)"),
  evidence: z
    .array(z.object({ kind: z.enum(["test", "log", "trace", "repro", "doc"]), ref: z.string().describe("where the evidence is: a test name, a log line, a trace id, a file") }))
    .optional()
    .describe("what backs the claim; REQUIRED for no_change_needed"),
  handback: z.object({ reason: z.string().describe("why this request is outside your brief") }).optional().describe("REQUIRED for status handback"),
};

export type ClaimInput = {
  status: ClaimStatus;
  summary: string;
  ran: Array<{ cmd: string; exit: number }>;
  changed: string[];
  ref: { pr?: number; commit?: string } | null;
  risks: string[];
  assumptions: string[];
  evidence?: Array<{ kind: "test" | "log" | "trace" | "repro" | "doc"; ref: string }>;
  handback?: { reason: string };
};

/** A recorded claim: the normalised input (trimmed, capped, deduplicated). */
export type Claim = ClaimInput & { evidence: NonNullable<ClaimInput["evidence"]> };

const SHA = /^[0-9a-f]{7,40}$/i;

/** Validate and normalise a claim. `ok: false` names every problem, so the worker fixes them in one
 *  retry (the ADR-0049 pattern: the engine rejects a shapeless report instead of guessing). */
export function checkClaim(input: ClaimInput): { ok: true; claim: Claim } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const summary = (input.summary ?? "").trim().replace(/\s+/g, " ");
  if (!summary) problems.push("`summary` is empty: say the user-visible outcome in one sentence");
  if (summary.length > CLAIM_LIMITS.summary) problems.push(`\`summary\` is ${summary.length} characters; at most ${CLAIM_LIMITS.summary}`);
  if (/\b[0-9a-f]{12,40}\b/i.test(summary)) problems.push("`summary` carries a commit hash: put it in `ref.commit`, keep the sentence plain");

  const strings = (name: "changed" | "risks" | "assumptions"): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input[name] ?? []) {
      const s = String(raw).trim();
      if (!s || seen.has(s)) continue;
      if (s.length > CLAIM_LIMITS.item) problems.push(`\`${name}\` has an item over ${CLAIM_LIMITS.item} characters`);
      seen.add(s);
      out.push(s);
    }
    if (out.length > CLAIM_LIMITS.items) problems.push(`\`${name}\` lists ${out.length} items; at most ${CLAIM_LIMITS.items}`);
    return out.slice(0, CLAIM_LIMITS.items);
  };
  const changed = strings("changed");
  const risks = strings("risks");
  const assumptions = strings("assumptions");

  const ran: Claim["ran"] = [];
  for (const r of input.ran ?? []) {
    const cmd = String(r?.cmd ?? "").trim();
    if (!cmd) continue;
    if (cmd.length > CLAIM_LIMITS.cmd) problems.push(`a \`ran\` command is over ${CLAIM_LIMITS.cmd} characters`);
    if (!Number.isInteger(r.exit)) problems.push(`\`ran\` entry "${cmd.slice(0, 40)}" has no integer exit code`);
    ran.push({ cmd, exit: r.exit });
  }
  if (ran.length > CLAIM_LIMITS.ran) problems.push(`\`ran\` lists ${ran.length} commands; at most ${CLAIM_LIMITS.ran}`);

  let ref: Claim["ref"] = null;
  if (input.ref) {
    const pr = input.ref.pr;
    const commit = input.ref.commit?.trim();
    if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0)) problems.push("`ref.pr` must be a real PR number (a positive integer), or omitted");
    if (commit !== undefined && !SHA.test(commit)) problems.push("`ref.commit` must be a git sha (7–40 hex characters), or omitted");
    if (pr === undefined && !commit) problems.push("`ref` is an empty object: give `pr` or `commit`, or null");
    ref = { ...(pr !== undefined ? { pr } : {}), ...(commit ? { commit } : {}) };
  }

  const evidence = (input.evidence ?? []).map((e) => ({ kind: e.kind, ref: String(e.ref ?? "").trim() })).filter((e) => e.ref);
  if (input.status === "no_change_needed" && evidence.length === 0) problems.push("`no_change_needed` needs at least one `evidence` entry (the test, log or trace that shows the code is already right)");

  const reason = input.handback?.reason?.trim();
  if (input.status === "handback" && !reason) problems.push("`handback` needs `handback.reason`");
  if (input.status !== "handback" && reason) problems.push("`handback.reason` is set but the status is not handback");

  if (input.status === "ready" && ran.length === 0) problems.push("`ready` with nothing in `ran`: run the project's checks, or report blocked/failed and say why");
  if (input.status === "ready" && ran.some((r) => r.exit !== 0)) problems.push("`ready` but a command in `ran` exited non-zero: fix it, or report blocked/failed");

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    claim: {
      status: input.status,
      summary,
      ran: ran.slice(0, CLAIM_LIMITS.ran),
      changed,
      ref,
      risks,
      assumptions,
      evidence,
      ...(reason ? { handback: { reason } } : {}),
    },
  };
}

/** The one-line form of a claim for a result line or a digest. */
export function claimLine(c: Claim): string {
  const checks = c.ran.length ? ` · ran ${c.ran.length} (${c.ran.filter((r) => r.exit === 0).length} ok)` : " · ran nothing";
  const ref = c.ref?.pr ? ` · PR #${c.ref.pr}` : c.ref?.commit ? ` · ${c.ref.commit.slice(0, 7)}` : "";
  return `claim ${c.status}: ${c.summary}${checks}${ref}`;
}
