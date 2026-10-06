# Claude auto-memory is the project memory

**Status:** proposed (2026-10-06). Item 1 of the decision is built; items 2-4 wait for the operator.

The governor reported `file write outside the project folder:
/root/.claude/projects/-home-eticket-v3/memory/project_tvp_hotels_agency_desk.md`. The operator asked
why workers write there and where project memory should live.

## What writes there

Claude Code **auto-memory**. Neo does not turn it on: the CLI does, by default, in every local
session. `settingSources` does not control it; the user settings (`/root/.claude/settings.json`) do
not mention it. The bundled CLI (SDK 0.3.289) resolves it as: off if `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
is truthy or `autoMemoryEnabled: false`; the directory is `autoMemoryDirectory` from policy, flag
(`--settings` / SDK `settings`), local, project (trust-gated) or user settings, else
`~/.claude/projects/<repo root>/memory/`. The key is the **git repository root**, so all worktrees
share one directory. The CLI loads the first 200 lines / 25KB of `MEMORY.md` into every session.

The company folder `/home/neo/agent` is inside the `/home/neo` repo, so the main agent's
auto-memory is `-home-neo/memory` — the same directory as the operator's interactive sessions in
`/home/neo`.

Measured 2026-10-06: 34 non-empty directories, ~730 notes. Largest: `-home-neo` 157, `-home-eticket-v3`
156, `-home-waselni` 127, `-home-adminli` 75. 85 notes in those four were written in the last 7 days.
`MEMORY.md` sizes: eticket-v3 18.5KB, waselni 19.7KB, neo 17.2KB (about 4-5k tokens a session each,
close to the 25KB cut-off).

Neo memory (Phase 2) is a second implementation of the same idea in `<folder>/memory/`, and it is
off (`memory.scopes: []`). So today auto-memory is the only live learned memory.

## Decision

Keep auto-memory where the CLI puts it, and make it the one project memory.

1. **Tainted briefs run with auto-memory off** (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). A tainted
   brief is isolated (no history, no resume). Without this it still loaded the operator's whole
   `-home-neo` index (prod hosts, open bugs, deals) next to customer text. Built.
2. The engine knows the path (`autoMemoryDir(folder)`: git common root, `CLAUDE_CONFIG_DIR`,
   sanitised), and the console shows and searches it (read-only view + FTS over the dir).
3. The dispatch preamble says where each kind of fact goes: learned facts to auto-memory; where the
   work stands to HANDOFF/WIP; rules to CLAUDE.md. No secrets in any of them.
4. Neo memory is not turned on as a second store. Its FTS recall and dream budgets are re-pointed at
   auto-memory, or the module is retired. The 4 files in `agent/memory/` move into `-home-neo/memory`.

## Considered options

- **(a) `<project>/.neo/memory/` in each repo.** Rejected. Ignoring it means an edit to a tracked
  `.gitignore` or a per-repo `.git/info/exclude`. `COPY . .` puts it into Docker images (notes name
  prod hosts). `git clean -fdx` deletes it. A worktree gets its own empty copy unless we resolve the
  main root. The operator's own sessions keep the default dir, so memory splits in two.
- **(b) `/home/neo/company/memory/<project>/`.** Rejected. It survives everything and the console can
  read it, but the engine can read the native path just as well. It needs a ~730-file migration, and
  it splits workers from the operator's own sessions unless every repo gets a local settings file.
- **(c) Keep the default dir, only allow the write.** Accepted as the base. ADR-0012
  (`outOfFolderWrites: allow`) already removes the prompt for own work. Items 2-4 fix what (c) alone
  lacks: visibility, search, one store.
- **(d) Turn auto-memory off for all workers.** Rejected. Neo memory is off, so workers would learn
  nothing between sessions, and ~730 live notes would stop loading.
