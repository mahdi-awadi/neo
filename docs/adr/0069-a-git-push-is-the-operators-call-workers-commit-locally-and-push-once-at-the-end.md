# A git push is the operator's call: workers commit locally and push once, at the end, after asking

**Status:** accepted (2026-10-30, built on dev, restart-gated). Amends ADR-0011 (what trust may approve)
and ADR-0063 (the standing rules). Related: ADR-0006 (the governor hook), ADR-0057 (side lanes never push).

## Context

The operator's rule (2026-10-30): workers must not push to GitHub during a task, because every push
starts paid CI/CD runs. A worker that pushes after each checkpoint starts many runs for one task.

How `git push` was gated before this change (checked in the code):

- The governor (`decide`, `src/engine/governor.ts`) escalated a push only through the keyword backstop
  `RISKY_BASH` (`git\s+push`). It missed `git -C <repo> push` and `git -c k=v push`.
- That escalation was a normal one, so a **trusted** folder approved it automatically
  (`buildCanUseTool`, `session-runner.ts`), so in a trusted project a push ran with no question
  (`trustNewProjects` makes new projects trusted).
- The PreToolUse hook runs the same `decide` before a project's settings allow rules (ADR-0006), so a
  `Bash(git:*)` allow rule cannot skip it.
- Side lanes already deny a push (ADR-0057). Loops and customer work deny every escalation.
- `agent/CLAUDE.md` asks the chief of staff to get approval for a push, but that is prose, not code.

## Decision

1. **The standing rule.** `PUSH_RULE` in `src/engine/standing-rules.ts` holds the operator's words
   verbatim. The dispatch preamble (`briefWithProjectDocs`) puts it in BUILD, after the finish rule:
   "Commit locally in checkpoints. Do NOT `git push` during the task. Push once, only when the whole task is
   complete, and only after asking the operator (ask_operator)." A loop iteration cannot ask, so
   `loopBrief` says `LOOP_PUSH_RULE` instead: commit locally, never push.
2. **Enforced in code.** `decide` finds a push with the shared shell reader (`walkBash` + `gitCall`), so
   `git -C`, `cd … &&`, `VAR=… git`, `git -c k=v` and `sh -c '…'` are all caught. A push is an
   **operator-only escalation** (`fenced: true`). Trust never approves it, autonomous paths deny it, and
   the escalation text tells the worker the rule. At the end the operator answers twice: the worker's
   ask_operator card ("push now?"), then the push's own approval. A command that only mentions "git push"
   (`grep "git push"`) keeps the old keyword escalation, which trust may still approve.
3. **The shared shell reader** (`bash-walk.ts`, also used by the project fence and the side lanes) now
   splits a line into simple commands with a quote- and heredoc-aware splitter (`splitCommands`). Before,
   it split at `;`, `&&` and `|` even inside quotes. So `git commit -m "fix; git push later"`, or a commit
   body in a heredoc, would have become an operator-only push. It also reads more shapes: a
   backslash-newline, a lone `&`, the keywords `do`/`then`/`else`/`!`, `bash -lc`/`sh -ec`, git by path
   (`/usr/bin/git`), `env -i`/`-u`, and `git subtree push`. These checks are stricter for the fence and
   the lanes too.
4. **The preamble ceiling** (a test, ADR-0063) goes from 5,000 to 5,200 characters to fit the
   operator's sentence verbatim.

## Rejected

- **Deny every push for workers.** It leaves the operator no way to say "yes, push now" from the same
  session. The rule says to push once at the end, after asking. An operator-only escalation does that.
- **Prompt only.** A worker under a long task forgets prose. The governor is where Neo enforces rules
  (CLAUDE.md: "rules that live in code, not prompts").
- **A new verdict kind ("operatorOnly").** `fenced` already means "only the operator may approve this,
  never trust". A second flag would mean the same thing in two places. The type comment and CONTEXT.md
  now list a push as one of the cases.
- **Exempt `git push --dry-run`.** It starts no CI, but it is rare, and an exemption is one more parser
  path to get wrong. Failing closed is cheaper.
- **A full shell parser (tree-sitter-bash) for the reader.** It would also read `$(…)`, functions and
  `case`. It is a native or wasm dependency, and it would replace the reader that the fence and the
  lanes also rely on. The quote-aware splitter fixes the false positives and the shapes found in review,
  with the existing tests unchanged. It stays the candidate if a missed shape shows up in practice.
- **Shorten other preamble rules to stay under 5,000 characters.** Their wording is the operator's and
  is pinned by tests. About 40 more tokens per brief is the smaller cost.

## Known limits

- A push hidden inside a script or a tool (`npm run release`, a `gh` command, a git alias) is not
  seen by the shell reader, nor is a push inside `$(…)` or a shell function. The standing rule still asks
  the worker not to do it.
- **Codex workers** never reach `decide` for their shell commands (Codex uses its own sandbox and
  approval policy, not `canUseTool`). For them only the standing rule applies, plus the sandbox's
  default of no network. Hardening the Codex adapter is already the next engine item (CLAUDE.md).
- A pending push approval follows the normal reminder and timeout (`governor.approvalRemindMs`,
  `approvalTimeoutMs`): no answer means no push.
