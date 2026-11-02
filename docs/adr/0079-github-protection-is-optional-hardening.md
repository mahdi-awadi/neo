# ADR-0079: GitHub protection is optional hardening

Accepted by explicit operator policy, 2026-11-02: native GitHub branch protection and repository
rulesets are optional for every repository, including private repositories. Their absence or paid-plan
availability must never by itself block publication or deployment. Existing configured protections
remain in force. CI, tests, security gates, scoped secrets, verified source/image identity, safe
backups/migrations, release concurrency, health checks and rollback remain independent requirements.

Use one statement in Neo's existing standing-rules module and its executable/advisory briefs, with
`docs/release-policy.md` as the human reference. Reject mandatory paid upgrades (contrary to the
operator's policy), automatic removal of existing protection (not authorized), and replacing checks
with prose or adding another approval gate (neither follows from making GitHub hardening optional).
No new technology or GitHub integration is needed. Historical vendor quotations remain evidence,
with clear annotations distinguishing them from the current operator policy.

Amend ADR-0072's tested context budgets for this explicit shared policy, not unrelated prose:
quick <3,200 characters (<3,900 with the long index line), standard <4,650 (<5,300),
big <5,000 (<5,650). Before this change the big long-index brief was already 5,141 characters;
retaining the full independent-safeguard list produces 5,582. Reject silently weakening rules or
removing safeguards to fit the former 5,200 ceiling. No runtime size/permission gate changes.
