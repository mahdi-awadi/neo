# Optional GitHub protection — specification

The operator explicitly authorizes implementing and publishing this policy update. It does not
authorize deployment or modification of existing GitHub protection.

## Interface and scope

Reuse `GITHUB_PROTECTION_RULE` in `standing-rules.ts` as one policy statement consumed by quick,
standard and big dispatch briefs, loop briefs, planner instructions and consult advice. Reuse the
existing brief interfaces; add no GitHub probes, configuration switches or release approval paths.

## Acceptance criteria

- Every generated worker/advisory brief states the policy exactly once: branch protection and
  repository rulesets are optional hardening, including private repositories; neither native feature
  availability nor a paid upgrade is a publication/deployment prerequisite.
- Existing configured protection and independent CI/test/security, least-privilege secrets,
  source/image identity, backups/migrations, concurrency, health and rollback safeguards remain.
  Existing authorization rules remain; the policy creates no deployment authority or new gate.
- The big preamble stays below 5,650 characters including the long index line (ADR-0079 explicitly
  amends the old 5,200 budget for this policy); quick/standard budgets remain separately bounded.
- Neo's project/company instructions, release-check recipe and relevant Markdown agree with the
  policy. Historical vendor quotations are labeled historical/advisory, not silently rewritten.
- Project-owned edits in prod-ops, mirshad, waselni and eticket-v3 require supported company dispatch
  and verified owner commits; a request note does not count as completion. Mirshad stale deferrals
  are superseded only with evidence of publication authorization #1113 and without changing active
  release state or unrelated unresolved safeguards.
- Targeted consumer tests fail before implementation and pass after it. Run the full tests and
  typecheck and report existing unfinished-work failures truthfully. Security hooks remain enabled.

## Edge cases

An unprotected private repository, inaccessible protection API, or unsupported paid feature is not
a release blocker. A failed required test/security check, missing credential scope, unverified image,
unsafe migration, concurrent release or failed health check remains a blocker on its own merits.
An owner project or global instruction file outside this session's writable/tool scope is reported
as inaccessible; never forge a privileged session or bypass the project dispatch fence.
