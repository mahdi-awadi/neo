# A loop prompt is a standing brief, not a dispatch

**Status:** accepted (2026-09-29)

ADR-0002 put the engineering baseline in the dispatch preamble so no brief can omit it. A **loop**
does not go through dispatch, and nothing noticed until the first real project loop was authored.

- `runProjectLoop` puts `LoopDef.prompt` into `Order.task` **verbatim**
  (`src/engine/project-loop.ts:58`); `briefWithProjectDocs` is called only on the dispatch path
  (`src/engine/dispatch.ts:347`). A loop worker therefore gets **no preamble**: no read-your-docs,
  no structural-map-first, no engineering baseline, no challenge-yourself, no stay-alive.
- `loopRunExtras` sets `runDeps.mcpServers` **only** for the dream loop
  (`src/engine/loops.ts:482`). A loop worker therefore has **no `ask_operator`** and no `dispatch`.
- Loop escalations are **auto-denied**, not asked (`src/engine/project-loop.ts:68`). Combined with
  the governor's default-escalate that makes a loop's tool envelope materially different from a
  dispatch's: `WebSearch` is auto-allowed, but `WebFetch` is refused, and so is any `Bash` matching
  `RISKY_BASH` — which includes `curl`, `wget`, `git push`, `deploy`, and the bare word
  `production` (so `--profile production` is refused too).

The built-in loops never exposed this because they are one-line self-repo chores ("run `bun test`
until green"). `waselni-store-readiness` — four store targets, months of work, external stores —
needs every one of those things, so the gap became load-bearing.

## Decision

1. **An operator-authored loop's `prompt` is a standing brief**: self-contained, carrying the
   project's rules and the engineering baseline itself, because nothing prepends them.
2. **The prompt states the loop's governance envelope** (WebSearch yes, WebFetch/`curl` no; never
   push/deploy/submit; production-profile builds refused), so the worker does not spend iterations
   rediscovering it against a silent denial.
3. **A blocking question goes out as the worker's text reply**, which is what reaches the operator
   on a scheduled fire (`startScheduledLoop` forwards worker text tagged `#project`), and is
   recorded as asked-on-<date> in the loop's own state file so it is asked **once**. The prompt
   still names `ask_operator` as the preferred path, so it stays correct if the engine later
   attaches it.
4. **A loop's state lives in a file in the project repo, not in its session** — `freshSession:
   true` plus a checklist file the operator can read and diff.

## Considered options

- **Wire `briefWithProjectDocs` + `neoMcpServers` into the loop path** so a loop is preambled and
  gets `ask_operator` exactly like a dispatch. This is the better long-term answer and is recorded
  as follow-up work. Rejected *now* on two grounds: it is an engine change that only takes effect
  on a daemon restart, and this loop had to ship without one; and it silently re-prices every
  existing built-in loop (the preamble is context the operator pays for on every iteration), which
  deserves its own decision rather than riding along with a loop definition.
- **Let the loop write into the ledger's decision queue directly.** Rejected: the engine owns
  decision state, and a worker mutating it is the "no AI in the engine" line run in reverse — the
  same reason the secretary loop reads its queue through the prompt and never through a tool.
- **Keep the loop's state in the resumed session (`freshSession: false`).** Rejected: session
  memory is invisible to the operator, is dropped by any context-policy clear, and cannot be
  reviewed or corrected. A file in the repo survives all three.
- **Shorten the prompt and rely on the project's own `CLAUDE.md`.** Rejected as the only mechanism:
  `settingSources: ["project"]` does load it, but the baseline the operator enforces is *Neo's*
  standing rule across every project, and the governance envelope is a fact about the engine that
  no project's `CLAUDE.md` knows.

## Consequences

- Operator-authored loop prompts are long, and the operator pays that context on every iteration.
  Accepted: the prompt replaces the preamble rather than adding to it.
- If the engine later preambles loops, these prompts duplicate it and must be trimmed.
- **A loop's declared budget is not its whole cost.** `runLoop` sums only `iterate()`'s `costUsd`
  (`src/engine/loop-runner.ts:54`); the judge run between iterations costs real money and is never
  added. A judge-goal loop actually spends about `budgetUsd` *plus one judge run per iteration*,
  and `Bounds.budgetUsd`'s "summed across iterations (incl. judge runs)" comment
  (`src/engine/project-loop.ts:16`) is wrong today. Recorded here, not fixed: the fix changes the
  shared `GoalCheck` signature and would need a restart to take effect.
