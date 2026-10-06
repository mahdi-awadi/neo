# Out-of-folder writes are pre-approved; an approval never waits forever

**Status:** accepted (2026-10-06)

The path fence (ADR-0011) escalated every Write/Edit/NotebookEdit outside the session's project
folder. In practice these were a worker's own auto-memory (`/root/.claude/projects/-home-<p>/memory/`)
and scratch files in `/tmp`. Each one stopped the run in `awaiting-operator` until a tap. Gold waited
4h+ and waselni 7h (2026-10-05/06), and neo run #37 blocked on `/tmp/neo-perf/measure.cjs`. The
watchdog skips sessions that wait on the operator, so nothing told the operator again. The progress
digest repeated the same step.

The operator gave a standing order (2026-10-06): "there is no need to approve this for any project
always presume its already approved, always for all project its always accepted".

## Decision

1. **One config knob, `governor.outOfFolderWrites: "allow" | "ask"`, default `"allow"`.** `decide`
   allows an out-of-folder write that has a path when the knob is `"allow"`. Absent or any other
   value is `"ask"` (the ADR-0011 fence escalation). The knob covers every own-work launch path,
   which includes loops.
2. **Own work only.** `profileDeps` gives the knob to every path except `ingress`. `sdkOptions` and
   `buildCanUseTool` force `"ask"` for a `customer`-sourced order. The customer ingress path does not
   pass `governor` to its dispatches, so they stay `"ask"`. Tainted briefs keep zero tools
   (`TAINTED_DISALLOWED_TOOLS`, no MCP).
3. **Nothing else changes.** Risky Bash (deploy, push, rm, …), WebFetch, foreign MCP and unknown
   tools escalate as before. Trust still never decides a fence escalation (it only exists under `"ask"`).
4. **An approval never waits silently.** Every operator-facing escalation (pipeline and dispatch)
   goes through `patientApproval`. It reminds the operator on the Decisions surface every
   `governor.approvalRemindMs` (default 30 min). After `governor.approvalTimeoutMs` (default 2 h) it
   fails closed: deny, an alert, an `approval_timeout` event, and an abort signal so Telegram/web
   drop the prompt and close the decision row. `0` turns either off.

## Considered options

- **Write roots (`/tmp` + the session's own memory dir only).** This was an earlier draft that was
  never merged. Rejected: the operator ordered *all* out-of-folder writes approved, and a root list
  would still stall on the next path nobody listed.
- **Hardcode the allow in `decide`.** Rejected: no hardcoding. The fence must stay one config flip
  away (`"ask"`).
- **Let `/trust` lift the fence.** Rejected again (ADR-0011): trust is per project and auto-approves
  risky Bash too. The operator approved writes, not everything.
- **Timeout = allow.** Rejected: an unanswered deploy or push must never run itself. A timeout fails
  closed.
- **Make the watchdog alert on `awaiting-operator`.** Rejected: the watchdog reads sessions, but the
  dispatch wait is inside a call. The wait owns its own clock, in one place, with the prompt it can
  cancel.

## Consequences

- A worker can write anywhere the daemon user can, without a prompt. Bash could already do that
  without asking. The fence remains for customer work and is one config flip away for own work.
- A risky action nobody answers is denied after 2 h. The worker gets the deny and reports. The
  operator can re-dispatch it.
- Restart-gated: the running daemon keeps the old fence and the silent wait until it restarts.
