// The verdict (plan 2026-11-02 W1.3, ADR-0073): what the ENGINE says a dispatch ended as, from the
// worker's claim (W1.1), how the run ended, and the gate's evidence (W1.4). One pure rule, so every
// surface (the dispatcher's result, the operator's line, the todo queue, the metrics) reads the same
// word. A claim is an input here, never the answer: `ready` becomes `ready` only when nothing the
// engine measured contradicts it.
import type { Claim, ClaimStatus } from "./report-tool";

export type Verdict = ClaimStatus | "unreported" | "stale";

/** What the gate measured. `ran: false` means it had nothing to run (no checks declared, not a
 *  repo, disabled); `error` names a gate that could not run at all (its absence is never "passed"). */
export interface GateResult {
  ran: boolean;
  declared: number;
  passed: number;
  failed: Array<{ cmd: string; exit: number; tail: string }>;
  /** HEAD moved after the gate ran: the evidence is for another revision. */
  stale: boolean;
  /** Uncommitted changes of the run's own (the gate verifies the commit, not the tree). */
  dirty: string[];
  /** Policy files that differ from the frozen policy (a worker changed what the checks mean). */
  policyChanged: string[];
  headSha?: string;
  policyHash?: string;
  error?: string;
}

export interface VerdictResult {
  verdict: Verdict;
  /** One plain reason, for the result line and the ledger. */
  reason: string;
  /** The claim and the verdict differ: the line says both. */
  disagree: boolean;
}

export function assignVerdict(i: { claim?: Claim; runOk: boolean; failure?: string; gate?: GateResult }): VerdictResult {
  const { claim, gate } = i;
  const out = (verdict: Verdict, reason: string): VerdictResult => ({ verdict, reason, disagree: !!claim && verdict !== claim.status });

  if (gate?.stale) return out("stale", `HEAD moved after the checks ran${gate.headSha ? ` (verified ${gate.headSha.slice(0, 7)})` : ""}; verify again`);

  if (!claim) {
    const why = i.runOk ? "the worker ended without calling `report`" : `the run ended badly (${i.failure ?? "unknown"}) with no report`;
    return out("unreported", why);
  }

  if (claim.status !== "ready") {
    // The worker's own negative or out-of-scope outcome stands; the engine has nothing to add that
    // would make it better. (no_change_needed gains a reviewer check in W1.8.)
    return out(claim.status, claim.summary);
  }

  // `ready` is the only claim the engine has to earn.
  if (!i.runOk) return out("failed", `the worker claimed ready but the run ended badly (${i.failure ?? "unknown"})`);
  if (gate?.error) return out("blocked", `the checks could not run: ${gate.error}`);
  if (gate && gate.dirty.length > 0) return out("blocked", `uncommitted changes in ${gate.dirty.length} file${gate.dirty.length === 1 ? "" : "s"} (the gate verifies the commit, not the tree)`);
  if (gate && gate.policyChanged.length > 0) return out("blocked", `the verification policy changed during the run (${gate.policyChanged.join(", ")}); the frozen policy was used — an operator must accept the change`);
  if (gate?.ran && gate.failed.length > 0) {
    const f = gate.failed[0]!;
    return out("failed", `${f.cmd} exited ${f.exit}${gate.failed.length > 1 ? ` (+${gate.failed.length - 1} more)` : ""}`);
  }
  if (gate?.ran) return out("ready", `${gate.passed}/${gate.declared} checks passed`);
  return out("ready", "no checks declared — the claim stands unverified");
}

/** The short form for a result line: `verdict ready (2/2 checks)` or `claim ready ≠ verdict failed: bun test exited 1`. */
export function verdictLine(v: VerdictResult, claim?: Claim): string {
  if (v.disagree && claim) return `claim ${claim.status} ≠ verdict ${v.verdict}: ${v.reason}`;
  return `verdict ${v.verdict}${v.reason ? ` (${v.reason})` : ""}`;
}
