# `project_message` — the chief of staff speaks to a project's session (ADR-0061)

Operator order 2026-10-29, building on ADR-0060 (#845). The main agent could only `dispatch` (new work,
queued behind a running or held todo) or send `project_notes` (information, read at the next step). When a
session was held on a limit wait it could not send "resume", so it told the operator to `/kill`. The operator
switches to the project in Telegram and types — that works at once. The agent must be able to do the same.

## The seam: one delivery function, two callers

`handleMessage` branch 1 (an addressed session) already does everything an operator message does: a live
session gets the text as a steer follow-up (Claude sees it at its next step; Codex after its turn), an idle
one is resumed with its SDK session, a closing or reopening one is turned away. It moves, unchanged, into

```ts
deliverToSession(session, text, chatId, deps, cause, hooks?) → Promise<DeliverOutcome>
type DeliverOutcome = { kind: "steered" | "after-turn" | "resumed" | "closing" | "reopening"; run?: SessionRun }
```

`handleMessage` calls it and replies as today (no behaviour change). The new tool calls it through one
operator-only dep, `DispatchDeps.projectMessage(project, text, cause)`, built in the pipeline (it owns the
`PipelineDeps` `resumeSession` needs). Ingress strips it like `notes` and `tools`, so a customer-driven run
never has the tool.

## The tool

`project_message({ project, text })` — on the company session only (like `sessions`, `dispatch`).

Checks, in order, each refusal a plain reason (code enforces; the agent decides when to use it):
1. `text` trimmed, 1..`projectMessage.maxChars` (default 500). Longer is new work: "use dispatch".
2. A main-lane session for `project` is registered (running or idle). None: "no open session — use dispatch".
   Never the company itself; never a side lane.
3. The target is own work: `order.source === "neo"` and not the customer chat. Else refused.
4. Rate limit: at most `projectMessage.perProjectPerHour` (default 6) delivered messages per project in the
   last hour (`project_message` events). Refusals do not count.
5. Deliver with `deliverToSession`. Outcomes: `steered` — "delivered; it sees it at its next step"
   (a held run: "it was held in a limit wait — this starts a turn now"; ADR-0060 then ends the hold with one
   re-send); `after-turn`; `resumed` — "delivered; the idle session woke"; `closing`/`reopening` — "not
   delivered: the session is closing/reopening, try again in a moment".

Every delivered message: one `project_message` event `{ project, chars, outcome }` (never the text), and one
transcript line `kind: "agent_message"`, filed under the company turn's cause (so it is in the operator's
console thread) and posted to the project's stream in Telegram as `🤖 chief of staff → <project>: <text>`.
The console labels it "chief of staff → <project>" (`threads.agentTo`, EN + AR).

What it must not do: start new work (a short cap, and the card says new work is `dispatch`), replace a
running task (it only steers, like the operator), bypass the todo queue (it never queues a todo).

## Acceptance criteria

1. Idle session → resumed with the text; `resumed`.
2. Held session (ADR-0060 limit wait) → the text starts a turn now; no second run; the old timer sends
   nothing.
3. Working session → steered, seen at its next step; the running task is not replaced.
4. Refused: empty or too long text; no session; the company or a side lane; a customer session; over the
   rate limit; the tool absent on the ingress path.
5. Delivered messages: a `project_message` event without the text, a transcript line `agent_message` under
   the company's cause, a Telegram line labelled "chief of staff → project".
6. `handleMessage` behaviour unchanged (its tests stay green).

## Edge cases

- Two projects with the same name in different roots: resolved like `dispatch` (workRoot + name).
- A session that closes between the check and the delivery: the `closing` outcome.
- The agent sends "resume" to a session that is not held: it is simply a steer; harmless.

## Docs

Tool card `docs/tools/project-message.md`, ADR-0061, CONTEXT.md, CONFIG.md, `agent/CLAUDE.md`:
`project_message` for "resume", "status?", "continue" into an open session; `dispatch` for new work;
`project_notes` for information to another project; never tell the operator to `/kill` for what this does.
