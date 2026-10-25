# ADR-0051: semgrep runs in parts with a per-repo limit, a baseline records what it missed, and a chained hook fails closed

Status: accepted (2026-10-25). Amends ADR-0024.

## Context

Two defects in the security kit came up when it was turned on for eticket-v3:

1. `scan.sh baseline` gave semgrep one fixed 30-minute run over every file of the repo. On
   eticket-v3 that run timed out twice. The baseline was then written without any semgrep
   findings, and nothing said so. Later scans report those old findings as new, so they block.
   One run over the whole repo also stages every file into the scanner container's 1 GB `/scan`
   tmpfs at once.
2. The pre-commit/pre-push template chains the hook that was there before (for example
   `.githooks/pre-commit.pre-neo`). When that file is missing, the template skips it and exits 0,
   so the project's own checks stop running without a word. A git worktree, or a clone where the
   renamed hook was never committed, gets exactly this.

## Decision

1. **Semgrep runs in parts.** Every layer splits its file list into parts of
   `semgrepChunkFiles` files (default 200). The parts run one after the other in the warm
   container; each part is staged, scanned and removed on its own, and has its own time limit
   `semgrepTimeoutSec` (default 1800; the write-time layer keeps its 50 s). Both values come from
   the project's `.security/config.json`; a missing or invalid value uses the default. A part that
   times out loses only its own files.
2. **A scan records what it missed.** A semgrep part with no output, a gitleaks file scan with no
   output and a gitleaks history scan with no report are written down as *missing parts*.
   `baseline.json` gets an `incomplete` list (empty when the baseline is complete), and every
   report file gets the same list for its own scan. A layer that runs against an incomplete
   baseline warns that old findings may show as new and says how to complete it. It still never
   blocks on this (ADR-0024: a scanner outage never stops work).
3. **A chained hook fails closed.** When our hook records a chained hook and that file is not an
   executable file, the hook prints why and exits 1. Re-running `init.ts` re-detects the chain, so
   a hook that was removed on purpose drops out of the chain by a deliberate operator step.

## Rejected

- **Only raise the fixed limit.** A bigger repo times out again, the 1 GB staging limit stays,
  and a timeout still loses every semgrep finding.
- **Run the parts in parallel.** Semgrep already uses every core per run; parallel parts compete
  for the same CPUs and memory and do not finish sooner.
- **Mark a scanner incomplete when its output is empty, for every scanner.** osv-scanner prints
  nothing for a repo without lockfiles, which is a complete result. Only the scans that can time
  out or fail without output (semgrep, gitleaks) are marked, by `scan.sh`, which knows why.
- **Keep the previous baseline's fingerprints for a tool that is incomplete now.** It hides that
  the new baseline is partial. A baseline is a deliberate full re-record; the `incomplete` list
  says exactly what to re-run.
- **Skip a missing chained hook with a warning.** That is the current defect: the project's own
  checks stop running, and a warning in a commit's output is not read.

## Consequences

- A large repo's baseline completes; a part that still times out is named in `baseline.json` and
  in every later scan's warning.
- `.security/config.json` gains `semgrepTimeoutSec` and `semgrepChunkFiles`.
- A repo whose chained hook is not committed cannot commit or push from a worktree until the hook
  is committed (or `init.ts` is re-run). This is intended.
- The kit change reaches a host only when the operator re-installs it (`install.ts`), and a repo's
  existing hooks change only when `init.ts` is re-run on that repo.
