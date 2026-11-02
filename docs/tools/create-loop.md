---
id: create-loop
kind: cli
status: active
owner: neo
when: "Use to author or edit a Neo loop (trigger, repeated action, goal) from the command line through the engine's own validated path. The web CRUD needs an admin session, which an agent does not have."
scope: all
env: []
cost: "free (host)"
limits: "writes the loop_defs table through the same validation as the console; the daemon picks the loop up on its next tick"
dataLeavesHost: false
tags: [loop, schedule, cron, automation, trigger, goal, create-loop]
examples:
  - "add a nightly docs-sweep loop"
  - "change the schedule of an existing custom loop"
  - "create a loop that reruns tests until they are green"
usage:
  commands: ["*create-loop.ts*"]
---
## How to call

From the Neo folder: `bun run tools/create-loop.ts <input.json> [--update] [--ledger <path>]`.

- `<input.json>` is one `LoopInput` object (see `src/engine/loop-validate.ts`). It may set `promptFile` (a path relative to the input file) instead of `prompt`.
- `--update` edits an existing custom loop; without it a taken name is refused.
- `--ledger` points at a different DB (tests). Checked-in definitions live in `docs/loops/`.
- No restart is needed: the scheduler re-reads `loop_defs` on every tick.

Reference: `docs/loops.md`, ADR-0004.

## When NOT to use

- Never write `loop_defs` by hand with SQL.
- A loop's prompt is a standing brief: it must carry the project's rules itself; the engine does not wrap it.
- Do not use it for a one-off task; dispatch or a todo is the right door.
