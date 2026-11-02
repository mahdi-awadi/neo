# Publication and deployment policy

Operator policy, 2026-11-02; [ADR-0079](adr/0079-github-protection-is-optional-hardening.md).
Applies to Neo and all operator-owned projects, including private repositories.

## Optional GitHub hardening

Native GitHub branch protection, repository rulesets and paid-plan protection features are optional
hardening, **never prerequisites to publication or deployment**. Their absence, an unavailable
feature/API, or a paid-upgrade requirement must not by itself block an otherwise authorized release.
Do not buy an upgrade, demand another approval, or invent a replacement approval gate solely for
this reason. Preserve and obey protections already configured; do not disable them or bypass hooks.

## Independent delivery safeguards

Use the project's existing checks and release workflow, independent of GitHub feature availability:

- Required CI, tests, typecheck and security gates still apply. A new high/critical security finding
  blocks; no hook bypass or baseline edits to make it disappear.
- Credentials remain least-privilege and scoped to the authorized project/environment; never expose
  secret values or replace scoped access with ambient credentials.
- Verify the published source commit and deployed image identity, including the existing pinned
  digest/provenance checks. Do not deploy an unidentified or substituted artifact.
- Preserve safe backups and migration checks, release concurrency controls, health/smoke checks
  and a usable rollback path.

This policy supplies no deployment authority. Existing task authorization, environment separation
and release ownership remain in force. It removes one invalid prerequisite, not unrelated controls.
Missing CI/security/backup/health evidence remains a real issue; missing native protection alone does not.

## Briefs, advice and historical decisions

`src/engine/standing-rules.ts` is the shared generated statement for quick, standard and big
dispatches, loops, planner instructions and consult advice. Its presence in source affects new
worker briefs only after the operator applies the running build; this task does not restart Neo.
The company workspace's local `agent/CLAUDE.md` mirrors the policy but is machine-local, not a
tracked source file. User-level rules outside this repository require their owning context to edit.

Historical research/vendor quotations recommending protection are evidence about those products,
not Neo release gates. In particular, the research notes `reliability_practices.md`,
`operator_experience.md`, `multi_project_orchestration.md` and
`multi_server_and_cross_project.md` under `docs/research/research_notes/Neo world class coding agent/`
must be read subject to this policy; paid feature availability there does not imply an upgrade gate.

Mirshad's current publication authorization is operator order **#1113**. Owning-project records that
deferred publication solely for missing native/paid GitHub protection are superseded by that order
and this policy. Do not cancel, restart or otherwise interfere with an active release. Deferrals for
unrelated controls remain valid until their actual cause is addressed.

## Cross-project application

Project-owned instructions and enforcement must be edited and committed by project-scoped workers
in prod-ops, mirshad, waselni and eticket-v3. A sent project note is not execution or verification.
Report each owner's files, commit and publication evidence; mark inaccessible authoritative sources
and unavailable dispatch routes explicitly instead of claiming all projects have been updated.
