---
id: project-message
kind: mcp
status: active
owner: neo
when: "Chief of staff only: say a few words to a project's OPEN session, as the operator does in Telegram — resume a session held in a limit wait, ask a hung or quiet one for its status, tell it to continue."
scope: [agent]
env: []
cost: "free (engine); the woken session's turn uses the subscription as any turn does"
limits: "at most 500 chars a message and 6 delivered messages per project an hour (config projectMessage); never a customer session"
dataLeavesHost: false
tags: [message, resume, status, continue, wake, held, limit, session, project, nudge]
examples:
  - "resume waselni, its limit is reset"
  - "ask eticket-v3 for its status"
  - "tell adminli to continue"
usage:
  tools: ["mcp__neo__project_message"]
---
## How to call

`project_message({ project: "waselni", text: "resume" })`. The text goes into that project's open session
through the operator's own delivery path (ADR-0061):

- a working session sees it at its next step (the running task is not replaced);
- an idle session wakes with it;
- a session held in a limit or API retry wait (`sessions` shows "held: limit wait") starts a turn now —
  `todo retry <id>` does the same for a held todo (ADR-0060).

The reply says what happened: delivered (and how) or refused (and why). The operator sees each message in
that project's stream as "chief of staff → <project>".

## When NOT to use

- A decision the project raised with `ask_operator`: that answer is the operator's (the tool refuses it).
- A session still starting, closing, or held at a big plan: refused with the reason; try again or tell the operator.
- Replies from a woken session go to the operator's stream, not back to you.

- New work: use `dispatch` (it queues behind the running task in the todo queue).
- Information or a request for another project to act on later: use `project_notes`.
- A project with no open session: use `dispatch`.
- Never tell the operator to `/kill` a session for something this tool (or `todo retry`) can do.
