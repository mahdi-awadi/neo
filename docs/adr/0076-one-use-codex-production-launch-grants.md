# ADR-0076: One-use Codex production-launch grants

## Context

Claude and Codex workers do not have equivalent authority boundaries. Claude's SDK path is governed
by Neo's `PreToolUse` policy and project fence; risky shell actions such as deployment, SSH, pushes
and HTTP calls become operator-visible decisions. Codex has no equivalent per-tool hook. Its current
native profile intentionally gives only `:workspace`, Git metadata (ADR-0074), and, when explicitly
configured, one Docker socket. Profile-backed turns also use `--ignore-user-config`, so they do not
inherit the daemon user's network, SSH, Cloudflare or Tailscale setup.

The requested Mirshad launch needs more than development workspace access. Treating a text request,
a project-wide `workerEnv` setting, or Codex's `on-request` approval as production authorization
would let an untrusted worker broaden its own authority. In particular, Neo's current dispatch
plan-watch/hold mechanism does not steer Codex turns, so an approved plan card alone is not a safe
grant.

## Decision

Introduce a disabled-by-default **one-use Codex production-launch grant**. Only a dedicated operator
approval action may create it. It binds the exact project, Codex provider, dispatch source, root
order, approved plan hash, declared capability set and a short expiry. It is atomically consumed at
the start of the *first* privileged Codex CLI process. A resumed/follow-up process never silently
reuses it: it must receive a new operator grant or Neo refuses that production-launch order before
start. Any mismatch, expiry, revocation, prior consumption, missing approval or unavailable
enforcement fails closed. Customer, ingress, consult, company, loop, side-lane and Claude paths
cannot receive this grant.

One pure resolver composes the existing ADR-0074 workspace grant with only the capabilities declared
for the matching production grant. It selects from a finite code-owned capability catalogue;
configuration may select validated capability IDs and nonsecret routing references but cannot define
arbitrary commands, hostnames, sockets or wildcard rules. Configuration never contains credential
values. The runner builds a new minimal environment allowlist for this path (required runtime/Codex
authentication variables plus exactly the declared references), rather than inheriting and scrubbing
`process.env`; it emits only grant IDs, capability names and outcomes to the ledger.

Network egress is a capability only if the pinned Codex sandbox can prove a per-destination rule.
If it cannot, Neo must use a separate technically enforced egress boundary (for example a dedicated
network namespace or policy proxy) and prove a non-allowlisted destination is denied. An `HTTPS_PROXY`
environment value is not an enforcement boundary. Docker remains one canonical authorization-proxy
or rootless socket, never `/var/run`.

Prod-ops access uses a dedicated broker with an exact socket, target/operation allowlist, audit and
expiry. A fresh per-turn broker capability is passed out of band from logs and argv; the broker
atomically verifies the grant ID, project, order, plan hash, capability, expiry, unused state and
peer UID/socket mode before an operation. The worker never receives a general SSH key,
`SSH_AUTH_SOCK`, the Tailscale daemon/admin socket, or the daemon user's home directory. Direct SSH
is allowed only as a separately approved fallback using a short-lived constrained credential, exact
generated SSH/known-host files and independent egress/Tailscale ACL enforcement.

## Rejected alternatives

- Enable a project-wide `codexProduction` or reuse `codexDockerSocket`: it would authorize every
  project task rather than one approved operation.
- Match task text, a folder, or a plan title: worker-controlled content is not authorization.
- Treat Codex `on-request` as the approval record: it is a CLI interaction, not Neo's durable
  operator authorization trail.
- Add Cloudflare values to `workerEnv`, config, argv or ambient Codex configuration: that leaks or
  makes credentials available outside the intended turn.
- Let configuration define free-form commands, hosts, sockets or wildcard capability rules: this
  would turn a declarative grant into arbitrary authority.
- Enable general network, `/var/run`, home-directory SSH material, an SSH agent, or the Tailscale
  control socket: each grants substantially more host or network authority than the launch needs.
- Rely only on an HTTP proxy variable: a process can ignore or unset it.
- Recreate Claude's arbitrary-command tool policy inside Codex: Codex exposes no equivalent hook;
  authority must be technically bounded outside the worker.

## Consequences

The first implementation is intentionally dispatch-only and cannot launch anything until the
operator supplies a bounded workflow, a final approved plan and the external enforcement
prerequisites. It adds ledger/audit state, an approval UI action, strict configuration validation,
resolver and runner tests, and a disposable end-to-end harness. A real target-host sandbox test is
required before any Mirshad launch. No current configuration becomes privileged merely by upgrading
Neo; a refused revalidation prevents startup rather than silently running an unprivileged production
order.
