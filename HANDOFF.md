# HANDOFF — project notes (ADR-0043)

## Goal
Let projects exchange information through Neo ("project notes", ADR-0043). A note is an attention
item for the operator; only the operator starts work. Plan:
`docs/superpowers/plans/2026-10-22-project-notes.md`; spec:
`docs/superpowers/specs/2026-10-22-project-notes-design.md`.

## Done — all 4 phases, on `dev` @ e1649d7 (restart-gated, NOT on master)
- Design: 74230b2 (ADR-0043, spec, plan, CONTEXT.md terms).
- P1 store and send: ce2ec83, f5c6e7c, 6378aaf, 85d9406 (migration 12, notes config, secret refusal, caps, `project_notes` tool on operator surfaces only).
- P2 read, ack, resolve, withdraw, the notes block: de76320, a5257b8.
- P3 operator side (brief templates, cause, resolve on done, sender in the console EN+AR): 8d893b9, 6547285.
- P4 preamble, fence reason, docs: fafc39f, ba104d9.
- Code-review fixes: 2890b80. Plan ticked: e1649d7.
- `/security-review`: no findings. Re-verified 2026-10-22: `tsc` clean, `bun test` 1989 pass, 0 fail.
- Also on `dev`: 2b5abdb (ADR-0042, tests keep temp folders in one per-run root).

## Next steps
1. With operator permission only: merge `dev` → master, then restart the daemon. Never restart without permission.
2. After the restart, check one real note end to end: prod-ops sends a note to eticket-v3 → it shows in `/attention` → todo → resolve.
3. For Neo to dispatch (other projects, not this repo): eticket-v3 `eticket-expo-app` Metro JS-heap OOMs; mirshad air version pin (Go 1.26 vs image 1.25).
4. Optional, needs the operator's yes: give loop and Codex workers Neo's MCP tools so they can use `project_notes`.

## Open decisions
- When to merge `dev` → master and restart (restart-gated work is piling up on `dev`).
- Accepted limit: at a "task done" handoff that still lists next steps, a note made into that todo resolves at once.

## Gotchas
- `bun test` fires no process `exit` event; use a global `afterAll` in the preload.
- The ingress path spreads the operator `DispatchDeps`; strip every new operator-only dep there (`notes: undefined`).
- Codex runs get no MCP servers; loops get only the dream-memory server.
- `threadArtifacts` sorts todos ascending with a limit; use `newestTodoInThread`.
- Write commit messages to a file and use `git commit -F` (the guard blocks some heredoc text).
- A worktree needs a `node_modules` symlink; remove it before `git worktree remove`.
