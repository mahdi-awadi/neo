# A dispatched worker and its helpers stay in their project

**Status:** accepted (2026-10-10) · narrows ADR-0012 (out-of-folder writes) for dispatch and loop
workers.

A mirshad worker (todo #109) started helper agents (subagents). Following an old handoff note that
listed eticket-v3 work, they created a Kurdish branch and wrote a plan file in `/home/eticket-v3`.
ADR-0012 pre-approves every out-of-folder write for own work, so the governor allowed all of it. The
governor did see those calls: a subagent's tool calls go through the same PreToolUse hook and
`canUseTool` as its parent, with the parent's folder. It simply had no rule against them.

## Decision

1. **The project fence.** `GovernorCtx.projectFence = { root, allow }` (`root` = config `workRoot`,
   `/home`). Every top-level folder under the root is a project. For a fenced session:
   - A Write, Edit or NotebookEdit whose path lies in **another** project root is a **fenced
     escalation**. The message reads: "write into another project (/home/x). Stay in your own
     project; send work for another project back to Neo to dispatch there." Trust never answers it
     (ADR-0011). Autonomous paths deny it.
   - The same goes for a Bash command that writes into another project:
     - git commit, checkout, switch, branch, merge, rebase, reset, worktree, add and similar, run
       there through `git -C`, `--git-dir`/`--work-tree`, or an earlier `cd`;
     - a redirection (`>`, `>>`) into it;
     - cp, mv, rsync, install or ln with a target there; tee, mkdir, touch, rm or `sed -i` on a path
       there.
   - Reading another project is still allowed.
   - Paths outside the work root (`/tmp`, `~/.cache`, the worker's own memory under `/root/.claude`)
     stay allowed under ADR-0012.
   - `allow` lists engine folders under the root that every worker may write: Neo's handoff notes
     (`handoffNotesDir`, ADR-0029).
2. **Who is fenced.** `profileDeps` sets the fence for the `dispatch` and `loop` paths only.
   Operator-opened sessions and the company keep ADR-0012 unchanged, because the operator drives
   them. Subagents are covered without extra wiring, because their calls re-enter the same governor.
3. **The brief says it too.** The dispatch preamble says: "stay in this project: never write,
   branch or commit in another project under /home, nor may your helper agents. Work for another
   project (even one an old note lists) goes back to Neo to dispatch." To keep the preamble under
   its 5000-character limit, the stay-alive paragraph lost two examples.

## Considered options

- **Deny instead of escalate.** Rejected. Shared work, such as `gopkg` changes for a Go project, is
  sometimes approved. The operator can still allow it, but a worker can never just do it.
- **Fence operator sessions as well.** Rejected. The operator often works across projects on
  purpose, and ADR-0012 is their standing order for their own sessions.
- **Fence by the git repository of the target instead of the `/home/<x>` folder.** Rejected. It
  needs a git call on every check, and the folder rule is the same one dispatch uses to name
  projects.
- **Only tell the worker, in the brief.** Rejected. An old note was enough to override the brief.
  The rule has to live in code (CLAUDE.md: "rules that live in code").

## Consequences

- A cross-project write by a dispatched worker now waits for the operator, through the same
  reminders and timeout as any approval (ADR-0012 §4).
- The Bash check reads common command shapes. It is defense in depth, like `RISKY_BASH`; the
  file-tool fence is exact.
- After code review the Bash check also reads: subshells, `sh -c`/`bash -c`/`eval` code (checked as a nested command), pipes, `git -c … -C`, the spaced `--git-dir`/`--work-tree` forms, `GIT_DIR`/`GIT_WORK_TREE`, `pushd`, `env -C`, `~`/`$HOME` and `cp -t`. A `>` inside quotes is text. File tools resolve symlinks, so a link inside the project that leads to another project is fenced. A sibling git worktree of the session's own repository (`/home/<repo>-wt-x`, whose `.git` file points into `<repo>/.git/worktrees`) counts as the same project.
- Known residuals (defense in depth): writes from interpreter code (`python -c open(…,"w")`), `tar -C`, `unzip -d`, `make -C`. A `cd` does not carry into the next Bash call, because the CLI resets the shell's folder when it leaves the project. Desks share Neo's top-level folder, so a desk is not fenced from `/home/neo`. The Codex adapter has no canUseTool hook; its own sandbox limits writes to its folder.
- Restart-gated.
