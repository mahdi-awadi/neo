---
id: disk-kit
kind: cli
status: active
owner: neo
when: "Use when the host disk is filling, or to see what the disk-cleanup loop can free. Tier A (rebuildable) is removed automatically; Tier B (irreversible) is only listed until the operator approves ids."
scope: all
env: []
cost: "free (host)"
limits: "Tier B is deleted only by id after an explicit approval; protected paths and running containers are never touched"
dataLeavesHost: false
tags: [disk, cleanup, space, docker, images, volumes, logs, cache]
examples:
  - "how much disk can we free and what is safe to remove"
  - "the disk is almost full, run the cleanup in dry-run mode"
  - "list the Tier B items that need operator approval"
usage:
  commands: ["*tools/disk/*", "*cleanup.ts*"]
---
## How to call

The `disk-cleanup` loop runs it daily. By hand, from the installed copy of `tools/disk/cleanup.ts`:

- `bun cleanup.ts measure` shows the inventory.
- `bun cleanup.ts check` shows what the policy would do.
- `bun cleanup.ts run --dry-run` is a safe rehearsal; `run` removes Tier A items.
- `bun cleanup.ts delete --ids <id,id,...>` removes exactly the Tier B ids the operator approved.

Reference: ADR-0040 and ADR-0041; defaults in `tools/disk/defaults.json`.

## When NOT to use

- Do not delete a Tier B item without the operator's approval of its id.
- Do not use it to clean a project's own build output that a live dev server needs.
- It never touches a running container, prod paths, the engine's data folders, or secret files.
