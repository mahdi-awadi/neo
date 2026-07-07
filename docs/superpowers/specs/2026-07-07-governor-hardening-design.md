# Governor hardening + no-tool draft workers — design

**Date:** 2026-07-07
**Status:** approved (findings 2+3 of the 2026-07-07 compliance review)

## Problem

Two gaps weaken the code-enforced approval gate (one of the two compliance-firewall rules):

1. **Prompt injection via customer email (finding 2).** `draftInboxReply` embeds the raw,
   untrusted customer email body into a brief and runs it through the normal company worker
   (`runCompanyBrief`), which has Write/Edit, most Bash, and the `dispatch` MCP tool. A malicious
   email can instruct the worker to act. Drafting needs **zero tools** — it only produces text.

2. **Allow-by-default governor (finding 3).** `governor.ts` auto-allows any tool it doesn't
   explicitly handle, `RISKY_BASH` is a bypassable keyword blocklist (misses `find -delete`,
   `dd`, `pkill`, `npm publish`, whitespace variants), and Write/Edit are allowed **anywhere on
   disk**, not just inside the session's project folder.

## Design

### A. Governor: default-escalate + path fence (`src/engine/governor.ts`)

`decide(tool, input)` gains a context argument: `decide(tool, input, ctx: { folder: string })`.
Every call site (only `buildCanUseTool` in `session-runner.ts`) passes the order's folder.

New policy, in order:

1. **Deny:** `AskUserQuestion` (unchanged — headless, unanswerable).
2. **Allow (read-only set):** `Read`, `Glob`, `Grep`, `TodoWrite`, `NotebookRead`,
   `ListMcpResources`, `WebSearch`, `Task`/`Agent` (sub-agent tool calls re-enter
   `canUseTool`, so subagents stay governed).
3. **Allow (Neo's own MCP tools):** names starting `mcp__neo__` (e.g. `dispatch`). Other
   `mcp__*` tools fall through to the default (escalate).
4. **Path-fenced writes:** `Write` / `Edit` / `NotebookEdit` — allow only when the target path
   (`file_path`, after normalization) resolves **inside `ctx.folder`**; a path containing `..`
   segments is normalized first, a relative path is resolved against `ctx.folder`. Outside the
   fence → **escalate** with a reason naming the path.
5. **Bash:** escalate on `RISKY_BASH` (extended — see below); otherwise allow. The regex is
   defense-in-depth only; the primary guarantees are the path fence and default-escalate.
6. **Default: escalate** (was: allow). Any tool not matched above — `WebFetch`, `KillShell`,
   unknown/new SDK tools, foreign MCP tools — asks the operator.

`RISKY_BASH` additions: `find … -delete`, `dd`, `mkfs`, `kill`/`pkill`, `npm publish`,
`gh pr merge`, `ssh`/`scp`, `truncate` — kept as plain word-boundary alternations. No attempt
at full shell parsing (explicit non-goal).

`WebFetch` intentionally lands on escalate-by-default: it is an exfiltration channel. Own-work
sessions can approve it per call (or via project trust, which already auto-approves
escalations); customer-tainted sessions auto-deny it (below).

**Effect on autonomous paths (no behavior regression):** loops and customer-driven runs already
answer every escalation with "deny", so for them default-escalate means default-deny — strictly
safer. Interactive sessions see at most an occasional extra approval tap (WebFetch, out-of-folder
writes), and project trust absorbs those for trusted projects.

### B. No-tool draft workers (`src/engine/ingress.ts`, `inbox-actions.ts`)

`runCompanyBrief` gains an option: `runCompanyBrief(brief, deps, { tainted?: boolean })`.
When `tainted: true` (set by `draftInboxReply`, the only caller that embeds untrusted customer
content):

- **`disallowedTools`** (existing `RunDeps` passthrough → SDK) blocks everything except text:
  `["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "KillShell"]`.
- **No MCP servers:** the `mcpServers`/`dispatch` option is omitted entirely — a tainted brief
  cannot dispatch sub-workers.
- Escalations remain auto-denied (already the case on this path).

Result: a drafting worker can read the project's CLAUDE.md context and produce an email body,
and nothing else. Defense in depth: even if `disallowedTools` missed a tool, the hardened
governor default-escalates → the path's auto-deny kills it.

The web `/api/inbox/draft` route and Telegram `/inbox` both go through `draftInboxReply`, so one
change covers both frontends (no forked paths — existing invariant).

## Error handling

- A fenced-write escalation reason includes the offending absolute path so the operator can
  judge it.
- Path normalization never throws: unparseable/empty `file_path` → escalate (fail closed).
- `decide` with a missing/empty `ctx.folder` treats every write as out-of-fence (fail closed).

## Testing (TDD, bun test)

- Governor: default-escalate for unknown tools and foreign `mcp__*`; allow-list intact;
  `mcp__neo__dispatch` allowed; Write inside folder allowed; Write outside folder / `../escape` /
  relative-path resolution / empty folder → escalate; extended RISKY_BASH cases; AskUserQuestion
  still denied.
- Session-runner: `buildCanUseTool` passes the order folder into `decide`.
- Ingress: `tainted` sets `disallowedTools` and omits `mcpServers` on the run call (assert via
  injected fake `run`); untainted call unchanged.
- Inbox-actions: `draftInboxReply` invokes the tainted path.

## Non-goals

- Full shell parsing / sandboxing of Bash (regex stays best-effort; fence + default-escalate
  are the real guards).
- Changing the trust model, loop runtime, or the Gemini customer path (Phase 3b).
- Network egress control beyond tool gating.
