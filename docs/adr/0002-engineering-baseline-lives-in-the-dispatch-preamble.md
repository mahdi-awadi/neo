# The engineering baseline lives in the dispatch preamble

**Status:** accepted (2026-09-18)

The operator's engineering baseline — standard i18n catalogues, `.env` + environments that default
to dev, Docker, no hardcoding, reuse what exists — defines what counts as an acceptable result.
Code that misses it is a failed order, even when it runs. The rule was written in this repo's
`CLAUDE.md`, and a worker dispatched into another folder never sees that file: only the *target*
project's `CLAUDE.md` auto-loads. So the baseline reached a worker only when whoever wrote the brief
remembered to type it, which is the definition of a rule that will be forgotten.

We therefore carry it in `briefWithProjectDocs` — the engine-owned **dispatch preamble** that
already carries the other rules a brief must never have to repeat (read the project's docs, query
the structural map first, design then build, challenge yourself, stay alive). `CLAUDE.md` remains
the one statement of the rule; the preamble is its delivery mechanism, phrased tightly.

## Considered options

- **Leave it to the brief author.** Rejected: that is today's behaviour and the reason the rule was
  raised. A standing rule enforced by memory is enforced only on the days it is remembered.
- **Copy the baseline into every project's `CLAUDE.md`.** Rejected: N copies drift, new projects
  start without it, and a project file cannot bind work in a folder that has none. The engine is the
  only place that sees every dispatch.
- **Put it in the governor instead, as a check on the result.** Rejected as the wrong instrument:
  the governor gates *tool calls* deterministically, and "is this i18n'd properly?" is a judgment
  about a finished change, not a tool decision. Refusing a `Write` cannot tell a worker how to build.
  A worker contract is the honest fit — the same conclusion the liveness rule reached (ADR-adjacent
  note in `docs/HISTORY.md`, 2026-09-13).

## Consequences

- The preamble grows ~700 chars (~175 tokens), paid on every dispatch. That is the price of the rule
  never being missed once; a test pins a 5000-char ceiling on the whole preamble so the block cannot
  quietly grow into an essay.
- Items are phrased stack-neutrally ("or the stack's equivalent") because dispatch targets range
  from a React Native app to a Go service to this engine itself. A worker in a repo with no
  user-facing strings simply has nothing to satisfy for item 1; the rule is not thereby weakened for
  the repos that do.
- The rule is now stated in exactly two places that cannot disagree by accident: `CLAUDE.md` (prose,
  for whoever reads the repo) and the preamble string (for every worker). Docs reference `CLAUDE.md`
  rather than re-listing the five items.
- Going live needs a daemon restart: the preamble is read at worker launch, so the running daemon
  keeps dispatching without the baseline until the operator restarts.
