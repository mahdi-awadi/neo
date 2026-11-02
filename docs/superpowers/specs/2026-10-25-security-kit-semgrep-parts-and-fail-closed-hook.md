# Spec: semgrep in parts, incomplete baselines, fail-closed chained hook (ADR-0051)

Small change to the shared security kit (`tools/security/`). Decision record: ADR-0051.

## Seams

- `scan.sh` `run_semgrep`: splits the files into parts and writes one output per part; any
  scanner that loses its output appends one line `tool<TAB>detail` to `$work/missing`.
- `findings.ts`: `--missing <file>` is read into `incomplete: { tool, detail }[]`. `baseline`
  writes it into `baseline.json`; `report` writes it into the report file, and warns when the
  baseline it reads has a non-empty `incomplete`.
- `init.ts` `hookScript`: a recorded chained hook that is not an executable file → exit 1.

## Acceptance criteria

1. A hook with a chained hook that is missing (or not executable) prints a message naming it and
   exits 1. A chained hook that exists still runs, with the same arguments and stdin.
2. Re-running `init.ts` when the recorded chained hook is gone re-detects the chain (none).
3. Semgrep gets parts of at most `semgrepChunkFiles` files (default 200), each run under
   `timeout <semgrepTimeoutSec>` (default 1800; write-time keeps 50). Both come from
   `.security/config.json`; a value that is not a positive integer uses the default.
4. A part with no output is a missing part. The baseline still records every other part's
   findings and lists the missing part in `incomplete`.
5. A baseline with no missing part has `incomplete: []`.
6. A `report` against a baseline with a non-empty `incomplete` prints a warning (what is missing,
   how to complete it) and does not block on that alone. The report file lists its own missing parts.
7. A gitleaks history scan with no report file is a missing part.

## Edge cases

- One file → one part. Zero scannable files → no semgrep run, nothing missing.
- An old `baseline.json` without `incomplete` reads as complete (no warning).
- A config value like `"1800; rm -rf /"` is rejected by the integer check and never reaches a shell.
