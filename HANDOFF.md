# HANDOFF — 2026-09-20

**Branch:** `fix/interactive-turns-bypass-budget-throttle` (off `fix/dispatch-stall-background-wait`,
unpushed). **State: GREEN** — `bunx tsc --noEmit` clean, `bun test` 818 pass / 0 fail.

## Just landed — session liveness (`62068c1` → `5657988`)

One activity clock feeds one derived session state: `starting` / `working` / `quiet` / `idle` /
`awaiting-operator` / `wedged`. Every operator surface renders that word — `/list`, the `sessions`
tool, the web console, and dispatch's busy replies — so `running` is gone from operator text. The
stall monitor and the watchdog now judge the state, not the age of a label. Detail:
`docs/HISTORY.md` and `docs/adr/0003-one-activity-clock-one-derived-session-state.md`. Telegram's
group command form (`/command@bot_username`) landed in the same batch (`82e42b1`).

## Also landed — `4127ce2` feat(dispatch): the engineering baseline rides in the worker preamble

The operator's hard rule (non-standard code is a failure even when it works — the five items are
listed once, in `CLAUDE.md`) is now carried by `briefWithProjectDocs` (`src/engine/dispatch.ts`),
so every dispatched worker gets it and no brief can omit it.

- **Root cause it fixes:** a dispatched worker loads the *target* folder's `CLAUDE.md`, never Neo's,
  so the baseline reached a worker only when the brief author remembered to type it.
- **Rejected:** per-project `CLAUDE.md` copies (N copies drift; new projects start without it) and a
  governor check (it gates tool calls, not judgments about a finished change). ADR:
  `docs/adr/0002-engineering-baseline-lives-in-the-dispatch-preamble.md`.
- **Cost pinned:** preamble 3627 → 4311 chars (~1080 tokens per dispatch); a test caps the whole
  preamble at 5000 chars, so a future rule must be phrased tightly, not appended as prose.
- TDD: 2 tests in `tests/dispatch.test.ts` (one assertion per baseline item + the size ceiling).
  Docs synced: `CONTEXT.md` (**dispatch preamble**, **engineering baseline**), `README.md`,
  `docs/HISTORY.md`, `WIP.md`, `CLAUDE.md`.

## Blocker — RESTART PENDING (operator-gated; nothing was restarted or reloaded)

The preamble is read at **worker launch**, so the running daemon keeps dispatching without the
baseline until the operator restarts it. Everything else on this branch waits on the same restart:
the liveness model (`62068c1` → `5657988`), work class follows the originating trigger (`36a454f`,
`e39e0d9`), and the no-background-wait preamble contract (`7e4d0a1`).

## In flight — uncommitted: the Agent SDK pin

`package.json` + `bun.lock` only. `@anthropic-ai/claude-agent-sdk` moves from `latest` to the exact
`0.3.270`, so two installs of the same commit get the same worker binary. The docs that record the
pin are committed: `docs/sdk-notes.md` (header), `docs/HISTORY.md`, `README.md`, `WIP.md`. `WIP.md`
asks to leave the pin itself alone, so it stays uncommitted until the operator decides. The Telegram
group-command work that used to sit beside it landed in `82e42b1`.

## Next steps

1. Operator: restart the daemon to activate the preamble, the liveness model + the work-class gate.
2. Decide the fate of the uncommitted SDK pin — commit it as its own piece or drop it.
3. Then resume the plan of record in `MVP-PLAN.md`: harden the Codex SDK adapter (sandbox/approval
   policy, not `canUseTool`), later context-efficiency phases, Phase 3b, Phase 4.
