// The gate (plan 2026-11-02 W1.4, ADR-0073): the engine runs the project's FROZEN checks for ONE revision
// in a CLEAN worktree with a scrubbed environment, and binds the evidence to that revision. The
// worker's tree is never trusted (it verifies the commit, not the tree); a HEAD that moves after the
// gate makes the evidence stale. Deterministic over git and the bounded runner; no AI.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { FrozenPolicy } from "./checks";
import { policyChanges } from "./checks";
import { git, headOf, type GitRunner } from "./git-read";
import { uncommittedIn } from "./dispatch-report";
import { runCommand, type RunCommandOptions, type RunCommandResult } from "./run-command";
import type { EnvScrubOptions } from "./worker-env";
import type { GateResult } from "./verdict";

/** Config `verify` (docs/CONFIG.md). */
export interface VerifyCfg {
  /** Off switch: no gate runs, every verdict is the claim's (or unreported). Default true. */
  enabled: boolean;
  /** One check's bound (the runner's own default applies when smaller). */
  checkTimeoutMs: number;
  /** All checks together; past it the rest are not run and count as failed. */
  maxTotalMs: number;
  /** Where clean worktrees are made (outside every project, removed after). */
  worktreeRoot: string;
  /** When true, `unreported`, `stale` and a failed gate make the dispatch a bad end for the todo queue.
   *  Default false while workers learn the `report` tool: the verdict is recorded and shown only. */
  requireReport: boolean;
  /** Chars of a check's output kept as evidence. */
  evidenceTailChars: number;
}

export const DEFAULT_VERIFY_CFG: VerifyCfg = {
  enabled: true,
  checkTimeoutMs: 10 * 60_000,
  maxTotalMs: 15 * 60_000,
  worktreeRoot: join(tmpdir(), "neo-verify"),
  requireReport: false,
  evidenceTailChars: 2000,
};

export function readVerifyCfg(raw: unknown): VerifyCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : d);
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_VERIFY_CFG.enabled,
    checkTimeoutMs: pos(r.checkTimeoutMs, DEFAULT_VERIFY_CFG.checkTimeoutMs),
    maxTotalMs: pos(r.maxTotalMs, DEFAULT_VERIFY_CFG.maxTotalMs),
    worktreeRoot: typeof r.worktreeRoot === "string" && r.worktreeRoot.startsWith("/") ? r.worktreeRoot : DEFAULT_VERIFY_CFG.worktreeRoot,
    requireReport: typeof r.requireReport === "boolean" ? r.requireReport : DEFAULT_VERIFY_CFG.requireReport,
    evidenceTailChars: pos(r.evidenceTailChars, DEFAULT_VERIFY_CFG.evidenceTailChars),
  };
}

/** One check's evidence: the command, how it ended, and the tail of what it printed. */
export interface Evidence {
  cmd: string;
  exit: number;
  durationMs: number;
  timedOut: boolean;
  tail: string;
}

export interface GateOutcome extends GateResult {
  evidence: Evidence[];
  /** The worktree the checks ran in (removed before this returns; kept for the ledger line). */
  worktree?: string;
}

export interface GateDeps {
  run?: (cmd: string[], opts?: RunCommandOptions) => Promise<RunCommandResult>;
  gitRun?: GitRunner;
  scrub?: EnvScrubOptions;
  now?: () => number;
}

/** Run the frozen policy's checks for `headSha` in a clean worktree of `folder`. Never throws: a gate
 *  that cannot run says so in `error` (and the verdict treats that as blocked, never as passed). */
export async function runGate(
  i: { folder: string; policy: FrozenPolicy; headSha: string; cfg: VerifyCfg },
  deps: GateDeps = {},
): Promise<GateOutcome> {
  const run = deps.run ?? runCommand;
  const gitRun = deps.gitRun ?? git;
  const now = deps.now ?? Date.now;
  const base: GateOutcome = {
    ran: false,
    declared: i.policy.checks.length,
    passed: 0,
    failed: [],
    stale: false,
    dirty: [],
    policyChanged: [],
    headSha: i.headSha,
    policyHash: i.policy.hash,
    evidence: [],
  };

  const head = headOf(i.folder, gitRun);
  if (!head) return { ...base, error: "not a git repository (or git failed)" };
  if (head !== i.headSha) return { ...base, stale: true };

  base.dirty = uncommittedIn(i.folder) ?? [];
  base.policyChanged = policyChanges(i.folder, i.policy);
  if (i.policy.checks.length === 0) return base;

  const dir = join(i.cfg.worktreeRoot, `${i.headSha.slice(0, 12)}-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(i.cfg.worktreeRoot, { recursive: true });
  } catch (e) {
    return { ...base, error: `cannot create ${i.cfg.worktreeRoot}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const add = await run(["git", "-C", i.folder, "worktree", "add", "--detach", dir, i.headSha], { timeoutMs: 60_000, maxOutputChars: 4000 });
  if (add.exit !== 0) return { ...base, error: `git worktree add failed: ${(add.stderr || add.stdout).trim().slice(0, 300) || `exit ${add.exit}`}` };

  const started = now();
  try {
    base.ran = true;
    base.worktree = dir;
    for (const cmd of i.policy.checks) {
      const left = i.cfg.maxTotalMs - (now() - started);
      const label = cmd.join(" ");
      if (left <= 0) {
        base.failed.push({ cmd: label, exit: 124, tail: "not run: the gate's total time was used up" });
        base.evidence.push({ cmd: label, exit: 124, durationMs: 0, timedOut: true, tail: "not run: the gate's total time was used up" });
        continue;
      }
      const r = await run(cmd, {
        cwd: dir,
        timeoutMs: Math.min(i.cfg.checkTimeoutMs, left),
        maxOutputChars: 200_000,
        ...(deps.scrub ? { scrub: deps.scrub } : {}),
        env: { NEO_VERIFY: "1", CI: "1" },
      });
      const tail = tailOf(`${r.stdout}\n${r.stderr}`, i.cfg.evidenceTailChars);
      base.evidence.push({ cmd: label, exit: r.exit, durationMs: r.durationMs, timedOut: r.timedOut, tail });
      if (r.exit === 0 && !r.timedOut) base.passed++;
      else base.failed.push({ cmd: label, exit: r.exit, tail: r.spawnError ? `could not start: ${r.spawnError}` : tail });
    }
  } finally {
    await run(["git", "-C", i.folder, "worktree", "remove", "--force", dir], { timeoutMs: 60_000, maxOutputChars: 4000 });
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }

  // Bound to the revision: the evidence is for `headSha` only.
  const after = headOf(i.folder, gitRun);
  if (after !== i.headSha) base.stale = true;
  return base;
}

function tailOf(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `…${t.slice(t.length - n)}`;
}
