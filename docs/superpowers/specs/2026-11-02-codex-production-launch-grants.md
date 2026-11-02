# Codex production-launch grants — specification

## Domain terms

Use the canonical definitions in `CONTEXT.md`: **Codex production-launch grant**, **declared
workflow capability**, **environment reference**, and **prod-ops broker**. A **turn** is one Codex
CLI process; a resumed session contains multiple turns and must not retain authority after a grant
expires or is consumed.

## Seam

`resolveCodexProductionLaunch(config, context, grant)` is the sole policy seam. It returns either
`none` or a typed, immutable profile fragment, named environment references and safe audit facts.
It selects only from a finite code-owned capability catalogue. It does not read credentials, parse
task prose, create approvals, or run commands. The runner is its only consumer; the dispatch
approval flow is its only issuer.

## Acceptance criteria

1. A production grant is created only by a dedicated operator action after an approved final plan;
   it binds project, provider, dispatch source, interactive work class, root order, plan hash,
   capability IDs, expiry and issuer. It is auditable, revocable and one-use; starting the first
   privileged Codex process atomically consumes it. A follow-up requires a new grant.
2. The resolver fails closed for every absent, malformed, expired, revoked, consumed or mismatched
   grant; mismatches include project, provider, launch path, source, work class, root order and plan
   hash. No prompt, folder, session resume ID or project config alone grants production authority.
3. Only a matching Codex dispatch turn gets the resolved profile. Company, customer, ingress,
   consult, loop, side-lane, handoff/judge/secretary and all Claude paths get none.
4. Git metadata access remains exactly ADR-0074. Docker is optional and only one canonical configured
   authorization-proxy/rootless socket is granted; neither `/var/run` nor a host directory is ever
   writable.
5. DNS/HTTPS is disabled unless the pinned sandbox has a tested, enforceable exact destination rule,
   or a separately enforced egress boundary is configured and proven to deny a disallowed host.
   DNS, HTTPS and prod-ops destinations are finite config entries, never prompt values or wildcards.
6. A Cloudflare capability has only validated environment-variable *names* in configuration. The
   active worker receives the referenced value through a newly constructed strict allowlist, not an
   inherited-and-scrubbed daemon environment; it never appears in config, events, arguments, error
   messages, test snapshots or diagnostics. Its token is independently scoped to the declared
   account/zone/actions.
7. Prod-ops access is an authenticated broker socket with immutable project/target/operation/expiry
   enforcement. It receives a fresh non-logged/non-argv per-turn capability and verifies grant,
   peer UID/socket mode, plan hash, expiry, revocation and one-use state atomically. No general SSH
   key, `SSH_AUTH_SOCK`, Tailscale control socket or home directory is exposed. A direct-SSH fallback
   is rejected unless constrained credentials, generated known-host material and independent
   Tailscale/egress restrictions are verified.
8. A follow-up Codex turn revalidates the grant before start. Expiry, revocation or prior consumption
   prevents this production order from starting; it never falls back to ambient or unprivileged access.
9. Tests cover config and resolver failure matrices, profile exactness, strict environment isolation,
   dispatch/runner plumbing, ledger audit/consumption, excluded paths and a disposable fake
   Docker/egress/broker harness proving permitted calls succeed and unrelated socket/host/command
   calls fail. The environment tests include a non-`.env` sentinel that proves no ambient daemon
   variable inherits. A target-host Codex sandbox harness is required before enabling the Mirshad
   workflow.

## Edge cases

- The plan changes after approval, a grant is approved twice, or two session turns race: only one
  atomically consumes it; stale plan hashes and duplicate actions are rejected.
- The configured reference is unset, blank, invalid or scrubbed: do not start the privileged turn.
- A capability is configured but its technical boundary cannot be instantiated or verified: fail
  before worker start and write a sanitized audit event.
- A Docker socket is symlinked, not a socket or inaccessible: preserve ADR-0074's closed failure.
- Network destinations resolve to a different address or redirect: enforcement is by destination
  policy, with redirects and arbitrary proxy bypass denied by the chosen boundary.
- The broker is unreachable, returns an authorization error, or the worker tries another target or
  command: do not retry by broadening the grant or exposing direct SSH material.
- A routing entry uses a wildcard, redirect, conflicting capability ID, DNS-rebinding target or a
  free-form command/socket: reject it during configuration/resolution.
- Restart between approval and execution: durable grant state remains valid only until its recorded
  expiry and exact plan/order context still match.
