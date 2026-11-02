---
approval: required
---

# Plan: one-use Codex production-launch grants

Spec: `docs/superpowers/specs/2026-11-02-codex-production-launch-grants.md`
ADR: `docs/adr/0076-one-use-codex-production-launch-grants.md`

This is a production-authority change. Do not build or enable it until the operator approves this
plan and supplies the prerequisites in step 1. It does not deploy Mirshad or restart Neo.

## Prerequisite audit — 2026-11-02

Neo's read-only ledger identifies the current candidate release plan as
`docs/superpowers/plans/2026-11-02-production-release-manifest.md` (plan `2983`, order
`a75a336b-b14a-445a-9482-30307c7bd88c`, hash
`7fba8389b595d4dfc44b1f31799f1910d2801cd49b63ca89674322ab9d7d8d91`). Its former approval decision
is superseded, so it is evidence of work context—not a Codex production grant. Neo has no tracked
finite egress policy, scoped Cloudflare environment reference/scope, approved Docker proxy decision,
or authenticated prod-ops broker contract. The installed local Codex sandbox has not demonstrated an
enforceable exact-domain rule. Step 1 therefore remains open; no capability may be enabled from this
evidence.

1. [ ] Obtain and record the exact approved launch plan/hash, root order, bounded targets, expiry,
   abort/rollback condition, whether Docker is genuinely required, exact HTTPS/DNS destinations,
   Cloudflare reference name and least-privilege token scope, and prod-ops broker contract. If direct
   SSH is proposed, require an explicit exception with short-lived constrained credentials, target
   host key, Tailscale ACL/service identity and egress restrictions.
2. [ ] Verify the installed Codex sandbox supports enforceable exact egress and file/socket rules.
   If it does not, design and provision an independently enforced egress component; do not substitute
   an environment proxy or broad network access. Add an ADR amendment for the chosen mechanism.
3. [ ] Add failing unit tests for a finite code-owned capability catalogue and parsing only nonsecret,
   finite descriptors that select its validated IDs. Reject free-form commands, hosts, sockets,
   wildcards, redirects, capability collisions and DNS-rebinding candidates. Extend `ProjectCfg` and
   configuration docs/examples without placing a real endpoint, token, host key or credential in source.
4. [ ] Add durable, transactional production-grant ledger state and a narrow operator approval action.
   Bind and audit issuer, project, order, plan hash, capabilities, creation, expiry, consumption and
   revocation. Atomically consume at the first privileged CLI start; a follow-up needs a new grant.
   Prove duplicate/racing approvals cannot yield two usable grants.
5. [ ] Implement `resolveCodexProductionLaunch` as a pure, fully tested fail-closed resolver. Make
   dispatch the sole initial launch path and explicitly reject all noninteractive, customer, loop,
   company, consult, side-lane and Claude contexts.
6. [ ] Extend the ADR-0074 native Codex profile composer with exact Git, optional canonical Docker
   authorization socket, proven egress, and broker-only rules. Preserve `--ignore-user-config`; never
   grant a parent directory, `/var/run`, home, arbitrary network, SSH agent or Tailscale admin socket.
7. [ ] Update `session-runner`, pipeline and dispatch so the first Codex CLI process atomically
   validates/consumes the grant and any later process refuses this production order without a fresh
   grant. Build a fresh minimal environment allowlist (including an ambient non-`.env` sentinel test),
   inject only configured reference names, and write sanitized audit events. A failed revalidation
   must prevent startup, not fall back to an unprivileged production turn.
8. [ ] Build a reproducible disposable integration harness with fake Docker authorization socket,
   egress policy and authenticated prod-ops broker. Give the broker a fresh per-turn capability and
   have it atomically verify the grant, project, order, plan hash, peer UID/socket mode, operation,
   expiry, revocation and replay state. Prove allowed Git/Docker/HTTPS/broker operations work and
   unrelated metadata, socket, host, command and environment access fail. Run an equivalent real
   target-host Codex sandbox test before enabling the workflow.
9. [ ] Update `CONTEXT.md`, configuration/runbook documentation and operator approval UX. Document
   config/apply/reload steps, secret provisioning by environment reference, revocation and emergency
   stop; do not restart Neo or deploy Mirshad as part of this change.
10. [ ] Run focused tests first, then full `bun test`, `bunx tsc --noEmit`, diagnostics, diff/security
    scans and `/security-review`. Obtain planner and code-review sign-off; commit the implementation
    without bypassing hooks. Only then present the exact operator apply/restart steps.
