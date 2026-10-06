# A dispatch has no wall clock, and it always reports to its dispatcher

**Status:** accepted (2026-10-04)

A dispatch had two limits. One was a wall-clock ceiling: 15 min by default, raised per call by
`timeoutMinutes`, and capped at 2 h. The other was a stall limit: 5 min with no streamed SDK
event. The operator's order (2026-10-04) was: "we don't need any limits, some tasks take hours;
all projects must keep sending reports to both the user and the main agent."

On 2026-10-04 an eticket-v3 plan run (order `d092bf72`) looked like it "stopped silently after
Task 4". The ledger and the transcript show the real cause:

1. The worker ran its plan with **background** subagents. Its first turn ended at about 14:33
   (`result`), but the CLI kept working on task notifications.
2. Dispatch treated that first `result` as the end of the brief. It **closed the input channel**
   (`queued() === 0`), and `active()` read false from then on.
3. At 15:01 the company dispatched another brief. Dispatch saw "idle" and pushed the brief into
   the closed channel. `push()` drops into a closed channel, so the brief was lost with no error.
4. The company got nothing until the whole run ended. The run would also have been killed at the
   2 h cap, in the middle of the plan.

## Decision

1. **No wall-clock limit.** `dispatchTimeoutMs`, `dispatchTimeoutMaxMs` and the `timeoutMinutes`
   tool argument are removed, and dispatch does not replace them with anything. The only automatic
   abort is the **stall limit**. That limit is true silence: no streamed SDK event, not waiting on
   the operator, not in an API backoff. A busy worker always streams events: partial deltas,
   subagent messages, `task_progress`, and the `tool_progress` heartbeat during a long tool. So a
   busy worker is never aborted. The operator can still `/kill` a run.
2. **"Done" means the SDK says the session is idle.** Long-running Claude sessions set
   `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. The runner then follows `session_state_changed`.
   The SDK documents its `idle` state as the "authoritative turn-over signal", sent only after
   background agents finish. `active()` follows that state. A new `onSettled` handler fires on
   `idle`, and dispatch closes the channel only there. A `result` is still a turn boundary
   (`onTurnComplete`, which drives the API-retry logic), but it no longer ends the brief. A CLI that
   never sends state events falls back to the old rule: settled at each `result`. Codex turns are
   always settled at `turn.completed`. One known gap: the CLI's own check for background work does
   not count a background **Bash** command (`run_in_background`). So `idle` can come while such a
   command still runs, and the run then closes. The dispatch preamble already tells workers never
   to wait on background commands, so this ADR does not change that rule. If `idle` never comes,
   the stall limit is still the backstop.
3. **No silent drop.** A run exposes `closed()`. Dispatch refuses to deliver into a closing session
   and returns a clear "retry shortly" message.
4. **Progress digest.** Every `dispatchProgressMs` (default 10 min, `0` turns it off), dispatch
   builds a short digest. It goes only when there was activity since the last digest. The digest
   holds the elapsed time, the current activity, the worker's latest note and the folder's last
   commit. The engine builds it, so it uses no AI. It goes to the operator's project chat (default
   priority, the muted DM, not the Decisions group) and to the company session if that session is
   live. Digests never wake the company, are never stored, and never include tool lines. This keeps
   the volume to one line per dispatch per interval (see the 2026-10-01 Telegram 429 ban). The cost
   is real: the company keeps a live session, so each digest is one company turn (low effort), and
   the company's short reply also shows in the operator's DM. The operator asked for periodic
   reports to the main agent, so this is the default. `dispatchProgressMs` is the dial, and `0`
   turns digests off.
5. **Dispatcher inbox (durable final results).** Each final result goes to a ledger table first,
   `dispatcher_inbox`, and is then delivered. Delivery is a follow-up into the live company. If the
   company has no live session, the company is resumed with the result ("wake"). A report that
   cannot be delivered yet stays in the inbox. Examples: during a reload drain, while the company
   is reopening, or while something else is running the company (an ingress brief). Dispatch never
   wakes a company that is already `running`, because two resumes of one SDK session would race.
   The report is queued in the same synchronous step as `dispatch_end`, so no crash can end a run
   with no report. A queued report is sent by a later delivery, by a live-only flush right after the
   company reopens and on every daemon tick, or it is prepended to the next message the operator
   sends the company. A brief pushed into a session the **operator** opened is not covered by any
   dispatch report, and the reply to the company says so.
6. **Where it stopped.** An abnormal end gets a "stopped at" line: the last commit in the folder,
   the worker's latest note and its last activity. Abnormal ends are a stall abort, an error, a
   crash, an API give-up and an interrupt. At boot, a `dispatch_start` with no `dispatch_end` means
   the daemon died or was reloaded during that run. Boot records the missing end
   (`interrupted: "engine restart"`) and puts a report in the inbox. The report gives the folder's
   HEAD *now*, labelled as such, because a later run may have moved it. Recovery runs first at
   boot, before anything can start a new dispatch. A run that wraps up during a reload drain is
   reported as cut short for the reload, with its stop point.
   Boot does not wake the company. A reload is an operator action, so the report waits for the
   operator's next message.

## Considered options

- **Keep `timeoutMinutes` as an optional per-call limit with no default and no cap.** Rejected.
  The only caller is the company model. It set the argument on almost every dispatch (ledger:
  30, 45, 60, 90, 120 min), because the tool description told it to "size it to the task". An
  optional limit would bring back the kill that the operator asked to remove. The stall limit
  and `/kill` already cover a run that is truly stuck.
- **Push every streamed line to the company.** Rejected. It would cost a company turn for each
  tool line and repeat the Telegram flood.
- **Make each digest a company turn and always wake the company for it.** Rejected. Progress is
  for information only. Waking an idle company for it costs turns and creates noise. Only a final
  result wakes the company.
- **Keep the close-on-first-`result` rule and fix only the dropped follow-up.** Rejected. The run
  would still look idle (and receive briefs) while background agents work, and the company would
  still get a non-final summary.
- **Count background tasks from `task_started`/`task_notification` pairs.** Rejected. The SDK
  itself says the edge events can be missed. The `session_state_changed` level signal is the
  documented one.
