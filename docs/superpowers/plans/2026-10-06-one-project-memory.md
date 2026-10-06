# Plan: one project memory (Claude auto-memory) — ADR-0020

Status: step 1 built on `fix/tainted-run-no-auto-memory` (restart-gated). Steps 2-5 wait for approval.

## Why workers write to `/root/.claude/projects/-home-<project>/memory/`

- It is **Claude Code auto-memory**. The CLI turns it on by default in every local session. Neo does
  not ask for it; `settingSources` does not control it.
- The dir key is the **git repo root**, so all worktrees of a repo share it.
- The CLI loads `MEMORY.md` (first 200 lines / 25KB) into every session in that repo.
- The operator's own Claude Code sessions use the same dir. Most notes from before Neo came from them.
- Off switches: env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` or setting `autoMemoryEnabled: false`.
  Move it: setting `autoMemoryDirectory` (user, local, policy or SDK `settings`; project scope is
  trust-gated).
- The governor flagged it only because the path is outside the project folder. With ADR-0012
  (`outOfFolderWrites: allow`, live after restart) own-work writes there pass without a prompt.

## Numbers (2026-10-06)

| Repo | Notes | MEMORY.md | Notes changed in last 7 days |
|---|---|---|---|
| neo (main agent + operator) | 157 | 17.2KB | 41 |
| eticket-v3 | 156 | 18.5KB | 21 |
| waselni | 127 | 19.7KB | 17 |
| adminli | 75 | 11.5KB | 6 |
| 30 other dirs | ~215 | small | — |

Neo memory (Phase 2): off (`memory.scopes: []`); `agent/memory/` holds 4 old files (172KB).

## Three memories today: overlap

- **Auto-memory**: live, loaded every session, written often.
- **Neo memory**: built, off. A second implementation of the same thing (index + recall + dream).
- **Project docs** (CLAUDE.md, HANDOFF.md, WIP.md): tracked, shared by git.
- Drift seen: the engineering baseline is in CLAUDE.md, the dispatch preamble, `-home-neo` memory
  AND `-home-eticket-v3` memory. TVP status is in `-home-neo` (`travelopro-provider-tvp-built`) and in
  5 eticket-v3 notes. The main agent's index copies project facts that the project index also has.

## Options

| | (a) `<repo>/.neo/memory` | (b) `neo/company/memory/<p>` | (c) default dir (+ engine support) | (d) off |
|---|---|---|---|---|
| Tracked files / `git pull` | needs ignore entry per repo | clean | clean | clean |
| Secrets/notes leak | into Docker build context | no | no | no |
| Survives worktree / reset / clean | no / no / no | yes | yes (keyed by repo root) | — |
| Survives handoff / sweet-spot clears | yes | yes | yes (outside the transcript) | — |
| Shared with operator's own sessions | no | no | **yes** | — |
| Main agent can read | yes (Read is unfenced) | yes | yes | — |
| Context cost / session | same cap | same cap | ≤25KB index (~4-5k tokens) | 0 |
| Search | needs Neo FTS | needs Neo FTS | Claude recall today; Neo FTS in step 3 | none |
| Console | needs work | needs work | needs work (step 3) | — |
| Migration | ~730 files | ~730 files | none | lose ~730 notes |

## Recommendation: (c) — auto-memory is the one project memory

1. **Built:** tainted briefs (inbox drafts) run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Before,
   they loaded the operator's full `-home-neo` index next to customer text.
2. **Preamble** (`briefWithProjectDocs`, one paragraph): learned facts → auto-memory; where the work
   stands → HANDOFF/WIP; rules → CLAUDE.md; never secrets; do not copy one project's facts into
   another project's memory — link to them.
3. **Engine path + console:** `autoMemoryDir(folder)` (git common root, `CLAUDE_CONFIG_DIR`, same
   sanitising as the CLI, test against the existing dir names). Console: read-only list + FTS search
   (reuse `memory-recall.ts`'s FTS5 index, pointed at this dir).
4. **Neo memory:** do not turn on `memory.scopes`. Re-point its recall + dream budgets at auto-memory,
   or retire the module. **Operator decision.**
5. **Migration:** move the 4 `agent/memory/` files into `-home-neo/memory` as topic notes, then
   prune the `-home-neo` index of facts that the project's own index already has (keep a one-line
   pointer). Prune `/tmp-*` and `gov-probe` dirs (test leftovers).

## Operator decisions

- Approve (c) as the one project memory.
- Neo memory Phase 2: re-point at auto-memory, or retire?
- Go-ahead for steps 2, 3, 5.
