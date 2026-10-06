# The governor runs as a PreToolUse hook, before settings allow rules

**Status:** accepted (2026-10-01)

Neo governed tools only through `canUseTool`. The SDK checks permissions in this order: hooks →
deny rules → ask rules → permission mode → **allow rules** → `canUseTool`. A worker loads its
project's `.claude/settings.json` (`settingSources: ["user","project"]`), so an allow rule there
approves a tool before the governor sees it.

A live probe proved it on SDK 0.3.286 (`spike/governor-bypass-probe.ts`, Neo's real `runOrder()`).
In a trusted folder with `{"permissions":{"allow":["Bash(git:*)"]}}`, the worker ran
`git push --dry-run …` and `git log --format=force` with **zero** governor calls. `/home/mirshad`
is trusted and allows `Bash(git:*)` and `Bash(docker:*)`, so this bypass was live there.

Trust matters. The SDK applies a project's allow rules only when the folder itself is a trusted
workspace (`hasTrustDialogAccepted` in `~/.claude.json`). In a folder that is trusted only through
a parent, it applied deny rules but not allow rules. A probe in an untrusted `/tmp` folder showed
no bypass for this reason.

## Decision

1. **The governor also runs as a `PreToolUse` hook** (`buildGovernorHook`,
   `src/engine/session-runner.ts`), with no matcher, so it sees every tool. This includes subagent
   (team) tool calls and MCP tool calls. A live probe confirmed that a team subagent's `git push`
   is escalated.
2. **The hook and `canUseTool` share one decision function: `decide()`.** The hook does not resolve
   anything itself. For an allow verdict it returns no opinion, so settings deny rules still apply.
   For a deny or escalate verdict it returns `ask`. A live probe confirmed that `ask` sends the call
   to `canUseTool` even when an allow rule matches. Escalation, trust auto-approve, the
   AskUserQuestion bridge and the fail-safe deny stay in `buildCanUseTool` only. `ask` also
   outranks an `allow` from another hook (for example, a project's own settings hook). A live probe
   confirmed this.
3. **The hook is synchronous and never throws.** A live probe showed that when a hook throws, the
   SDK **fails open**: the allow rule approves the call. A hook timeout probably fails open in the
   same way. So the hook never waits on the operator, and any error returns `ask` (fail closed).
4. **Governance keys go last in `sdkOptions`**: `permissionMode: "default"`, `canUseTool` and
   `hooks`. No per-run field can replace them. The mode is explicit because from 0.3.286 an unset
   mode can start a session in auto mode.

All Claude launch paths (interactive, dispatch, loops, judge runs, team mode, ingress) build their
options in `sdkOptions`, so one change covers them all. `tests/governor-hook.test.ts` checks this
on both entry points for each option shape.

## Considered options

- **Resolve the whole decision in the hook (wait for the operator there).** Rejected. An escalation
  can wait for hours, and a hook that fails or times out fails open. Also, the trust, AskUserQuestion
  and fail-safe logic would have to move or be copied.
- **Return `deny` from the hook for deny verdicts.** Rejected. The only deny verdict is
  `AskUserQuestion`, and `canUseTool` must service it as a tracked decision first. `ask` sends it
  there and keeps one owner.
- **Strip or override project allow rules (drop `"project"` from `settingSources`, or pass our own
  settings).** Rejected. `"project"` also loads the folder's CLAUDE.md, `.mcp.json` and skills,
  which workers need. Editing other projects' settings files is not the engine's job, and the next
  allow rule would open the hole again.
- **Use `allowedTools` / `disallowedTools` lists.** Rejected. They are static and cannot express the
  path fence or the risky-command check.
