---
id: project-notes
kind: mcp
status: active
owner: neo
when: "Use to tell another project something through the engine: a finding, a heads-up or a request for work. The note is an attention item on the target; it never starts work by itself."
scope: all
env: []
cost: "free (engine)"
limits: "a note is refused when over its size caps, when it matches a secret pattern, or when you exceed the daily and open-per-target caps (see CONFIG.md, notes)"
dataLeavesHost: false
tags: [notes, project, finding, request, handoff, cross-project, tell, attention]
examples:
  - "tell eticket-v3 that a committed login needs rotating"
  - "send a request to prod-ops to check the deploy"
  - "list the notes other projects sent to this one"
usage:
  tools: ["mcp__neo__project_notes"]
---
## How to call

The tool is `project_notes` in the `neo` MCP server. Actions: `send`, `list`, `show`, `ack`, `resolve`, `withdraw`.

- `send` needs `to` (the target's folder name), `kind` (`finding`, `fyi`, `request`), `severity`, a one-line `title`, a `body` with the facts (what, where, how you know), and your own `ref` (the same ref again updates the same note).
- `list` shows notes for this project (`box: to`, default) or notes it sent (`box: from`); `show`, `ack`, `resolve` and `withdraw` take the note number `id`.
- `resolve` takes `how`: `fixed` (with the `commit` sha), `not_needed` or `duplicate` (with a `reason`).

Reference: ADR-0043, `CONTEXT.md` (Project notes).

## When NOT to use

- Never put a secret value in a note.
- Do not use it to do another project's work or to edit its files; the sender's work stays in its own folder.
- For a decision that needs the operator, use `ask_operator` instead.
