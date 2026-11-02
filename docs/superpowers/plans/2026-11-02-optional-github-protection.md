# Optional GitHub protection implementation plan

> For agentic workers: use the existing execution workflow task by task; the operator already
> explicitly authorized these policy edits, necessary fixes and commit/push publication.

**Goal:** Apply the operator's optional-protection policy without removing existing protections or
independent release checks.

**Architecture:** One shared statement in `standing-rules.ts`, consumed by existing briefs. Update
human policy references and delegate owning-project changes through the existing company route.

**Tech stack:** Existing Bun/TypeScript, Markdown and project tools; no new dependency or service.

**Spec:** `docs/superpowers/specs/2026-11-02-optional-github-protection.md`.

## Global constraints

Native/paid GitHub protection is optional, including private repositories. Preserve configured
protection and independent delivery safeguards. No production deployment, secret exposure, new
approval gate, out-of-project writes or security hook bypass.

## Review focus

Quick briefs and read-only advice must not retain a contradictory requirement. Private repositories
must not imply a paid-plan upgrade. Existing protected repos retain their checks. Wording must not
authorize a deployment. Cross-project notes must never be reported as executed edits.

### Task 1: Shared generated policy

Files: `src/engine/standing-rules.ts`, `src/engine/dispatch.ts`, `src/engine/consult.ts`,
`tests/standing-rules.test.ts`. Interface: `GITHUB_PROTECTION_RULE: string`, consumed once per brief.

- [x] Add consumer tests for the rule in quick/standard/big/loop/planner/consult briefs and the
  existing size ceiling; run `bun test tests/standing-rules.test.ts` and observe the missing rule.
- [x] Add the shared statement, reuse it in those briefs, then run the same tests green.

### Task 2: Canonical instructions and project ownership

Files: `CLAUDE.md`, `CONTEXT.md`, `docs/release-policy.md`, `docs/CONFIG.md`,
`docs/tools/deploy-check.md`, local `agent/CLAUDE.md`. Canonical policy explicitly distinguishes
historical research/vendor quotations from active rules; preserve the original quotations.

- [x] Record canonical terms and operator policy, preserve independent checks, annotate historical
  vendor recommendations, and update Neo's local company instructions.
- [ ] Obtain actual project-scoped execution and commit/push evidence from prod-ops, mirshad,
  waselni and eticket-v3. Record inaccessible sources/tools explicitly; never mark notes complete.

Execution boundary: this project-worker registry exposes no `dispatch`, `project_message` or company
todo tool; company consult #721 explicitly confirms it is read-only and cannot execute. Main request
#714 and owning-project requests #717–720 carry the authorized scope, but are NOT executed edits.
The user-level `/root/.claude/CLAUDE.md` was readable (no protection prerequisite found) but is
outside this session's writable scope. Local company instructions `agent/CLAUDE.md` were updated
in place and remain intentionally ignored machine-local state; tracked policy is `docs/release-policy.md`.

### Task 3: Verification and publication

- [x] Audit active scoped rules with targeted searches, run focused/full tests and typecheck, and
  obtain final planner/code review. Record named pre-existing/WIP failures separately.
- [ ] Commit through the existing security hooks and push the authorized Neo policy update; report
  exact commits, owner-project results and any concrete remaining blockers.

Verification, 2026-11-02:

- Consumer regression failed first (missing policy); final consumer/budget suite: 16 pass, 0 fail.
  Broader dispatch/consult/size/rules suite: 146 pass, 0 fail.
- Full `bun test`: 3,112 pass, 156 fail, 1 error (3,268 tests). Sandbox/runtime fixtures and existing
  unfinished work remain failing; this is not a green full-suite claim. Policy/size consumers pass
  in that full run too. Logs: `/tmp/neo-protection-full.log`, `/tmp/neo-protection-focused-final.log`.
- `bunx tsc --noEmit` (twice): exit 2, the existing `tests/file-kind.test.ts` import of missing
  `../src/engine/file-kind`; no policy-change diagnostic. Final log:
  `/tmp/neo-protection-typecheck-final.log`.
- Targeted tracked-source/Markdown audit found no active native/paid-protection prerequisite in
  Neo; remaining research mentions are historical/vendor evidence, subject to the canonical policy.
  Audit: `/tmp/neo-protection-audit.log`. Other owning projects are not audited by this worker.
- Final planner/code review approved after exact-seam coverage and plan-status corrections.
  `git diff --check` passes. The security kit's staged invocation exits 0 but explicitly warns
  Docker is unavailable (`/var/run/docker.sock` permission denied), so deep scans were **skipped**,
  not reported clean. Mandatory commit/push hooks remain enabled and unmodified.

No daemon restart, deployment, GitHub protection setting or release-state mutation occurred.
