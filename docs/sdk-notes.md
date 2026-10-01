# Claude Agent SDK — verified notes (Phase 0 spike)

The runtime dependency is pinned to `@anthropic-ai/claude-agent-sdk@0.3.286` in `package.json`.
The Phase 0 observations below were originally verified against `0.3.183` on 2026-06-19 by running
`src/spike.ts` (now deleted). Phase 1 builds on those observations.

## Model ids exposed by the bundle (0.3.286, read 2026-10-01)

The bundle carries the canonical list, so it can be read rather than guessed:
`grep -rhoE 'claude-(opus|sonnet|haiku|fable)[a-z0-9._-]*' node_modules/@anthropic-ai/claude-agent-sdk/`.

```
claude-3-5-haiku     claude-fable-5      claude-opus-4-0   claude-opus-4-7   claude-sonnet-4-0
claude-3-5-sonnet    claude-fable-5-1    claude-opus-4-1   claude-opus-4-8   claude-sonnet-4-5
claude-3-7-sonnet    claude-haiku-4-5    claude-opus-4-5   claude-opus-5     claude-sonnet-4-6
claude-mythos-5      claude-mythos-5-1   claude-opus-4-6   claude-opus-5-5   claude-sonnet-5
                                                                             claude-sonnet-5-5
```

Aliases: `sonnet`, `opus`, `haiku`, `fable`, `best`, `opusplan`, and the 1M-context forms
`sonnet[1m]`, `opus[1m]`, `fable[1m]`. `[1m]` is a context-size tag the bundle strips from any
canonical id (`c.replace(/\[1m\]$/i,"")`), so `claude-opus-5-5[1m]` is a valid spelling.

An alias is **release-dependent** and the SDK says so itself when one is used in an allowlist: *"it
names a different model depending on the release and settings. Name the model instead, for example
`claude-opus-5-5`."* That is why Neo pins ids — see ADR-0005 and `docs/CONFIG.md` "Worker models".

`claude-opus-5-5`, `claude-opus-5-5[1m]`, `claude-sonnet-5-5` and `claude-fable-5-1` were each run
against the live API on 2026-10-01 and accepted. The `[1m]` request reports `message.model` as
`claude-opus-5-5` with the tag stripped, so a transcript **cannot** tell a 1M run from a 200k one —
which is why `MODEL_WINDOW_TOKENS` (`src/engine/context-policy.ts`) still keys only `default`.

## Entry point

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
for await (const msg of query({ prompt, options })) { /* ... */ }
```

`query()` returns an async generator of `SDKMessage`. Runs in a **plain bun process — no
terminal, no TTY, no tmux**. Confirmed headless.

## Options that matter for Neo (all verified working)

- `cwd: string` — the project folder the worker opens ("open the project").
- `settingSources: ["user", "project"]` — **`user` loads `~/.claude` `enabledPlugins` so workers get the
  operator's plugin skills (superpowers etc.); `project` loads the folder's `CLAUDE.md` (+ `.claude/` settings, `.mcp.json`).**
  Confirmed: the worker read the seeded CLAUDE.md and followed its rule. (No global `~/.claude/CLAUDE.md` exists, so user
  scope adds plugins without injecting global instructions; the firewall stays in `canUseTool`, independent of settings.)
- `skills: "all"` — **the single switch that turns skills on.** Omitting it leaves skills to ambient CLI
  defaults (fragile across hosts); `"all"` enables every discovered skill, so superpowers + workflow skills
  are always ready for the worker in any folder. Discovery still comes from `settingSources: ["user"]` →
  `~/.claude` `enabledPlugins`, so the superpowers plugin must stay enabled there.
- `systemPrompt: { type: "preset", preset: "claude_code" }` — full Claude Code behavior.
- `permissionMode: "default"` — sends non-pre-approved tools through `canUseTool`. `AskUserQuestion` is
  **denied** here (the governor) with guidance to ask in plain text — its structured options can't reach the
  operator's channel and there's no answer-bridge, so left enabled the worker reads the empty result as "you
  didn't pick" and guesses. Plain-text questions surface via `onMessage`; the reply returns as a follow-up.
- `maxTurns: number` — bounds the agentic loop.
- `includePartialMessages: true` — stream partial/streaming events (`SDKPartialAssistantMessage`,
  `msg.type === "stream_event"`) as the worker generates. Without it a single long turn emits **no**
  SDK message until it completes, so a worker writing a huge file goes quiet for minutes; with it the
  steady drip of stream events keeps Neo's dispatch stall monitor alive (it isn't mistaken for
  silence). Neo consumes these purely as a liveness heartbeat, not for content. Added 2026-07-17.
- `canUseTool` — the governance hook (see below).
- (for Phase 1) `mcpServers`, `resume`, `model`.

## canUseTool — the governance hook (KEY FINDING)

```ts
canUseTool: async (tool, input) => {
  if (safe(tool)) return { behavior: "allow", updatedInput: input };  // <-- updatedInput REQUIRED
  return { behavior: "deny", message: "why" };
}
```

- **The `allow` branch MUST include `updatedInput`** (echo `input` unchanged, or a modified copy).
  Returning bare `{ behavior: "allow" }` is rejected by the SDK's Zod schema with a `ZodError` and
  the tool call fails. The TS type marks `updatedInput?` optional, but runtime requires it.
- `deny` requires a `message` (surfaced to the worker, which then adapts).
- Confirmed: `canUseTool` fires per tool request; a denied `Bash` was reported back to the worker
  as the deny message; allowed `Write` executed and created the file.

→ Engine impact: `session-runner` translates the governor's `Verdict` into a `PermissionResult` and
**must echo `updatedInput` on allow**.

## Message stream (observed `msg.type` values)

- `"system"` — lifecycle; `subtype: "init"` first, also `"thinking_tokens"`.
- `"stream_event"` — a partial/streaming delta (`SDKPartialAssistantMessage`), emitted only when
  `includePartialMessages: true`. Carries no completed block; Neo uses it as a liveness pulse
  (`onHeartbeat`) to keep the dispatch stall clock fresh, never for content.
- `"assistant"` — `msg.message.content` is an array of blocks; text is `block.type === "text"` →
  `block.text`.
- `"result"` — terminal; `subtype: "success"`, plus `total_cost_usd`, `num_turns`. Read the final
  outcome here, but do **not** trust `subtype` alone: Claude API failures can arrive as
  `subtype:"success"` with `is_error:true`. Neo treats that as a failed turn and resolves
  `RunResult.apiError` from, in order, the assistant `error` field, `api_error_status` (429 →
  `rate_limit`, 529 → `overloaded`, 401/403 → `authentication_failed`, 5xx → `server_error`), then
  recognizable result text such as "temporarily limiting requests" / "Rate limited". If none match,
  the kind is `unknown`; successful later turns clear the prior turn's API error.

## Auth

Ran on the environment's existing Claude credentials with **no `ANTHROPIC_API_KEY` set** — i.e., it
drew from the subscription, consistent with the provider firewall. Cost was reported per run
(`total_cost_usd ≈ $0.09`), so the SDK surfaces spend even on the subscription path → feed it into
the budget guard.

## Proven end-to-end

Headless run → opened folder → loaded+honored its CLAUDE.md → governed tools via `canUseTool`
(allow Write, deny Bash) → wrote `hello.txt` in the folder → streamed structured messages →
`result: success`. The whole Neo execution model works; Phase 1 is implementation, not discovery.

## Phase 2 — streaming input + interrupt + resume (verified 2026-06-19)

Confirmed against `sdk.d.ts` (the installed types are authoritative) **and** a real `src/spike-p2.ts`
run (now deleted). Findings:

- **Streaming input works.** `query({ prompt })` accepts `prompt: string | AsyncIterable<SDKUserMessage>`.
  Passing a pushable async-iterable keeps one session alive across turns — a message pushed mid-run
  reaches the **running** worker (spike: a follow-up created `two.txt` in the live session). This is
  Neo's `startOrder` model.
- **`SDKUserMessage` requires `parent_tool_use_id`.** Shape is
  `{ type:"user", message: MessageParam, parent_tool_use_id: string | null, ... }`. The
  `parent_tool_use_id` field is **required** (use `null`); omitting it is the streaming analogue of the
  Phase-0 `updatedInput` gotcha. `message` is the Anthropic `MessageParam` — `{ role:"user", content }`
  with `content` as a plain string accepted. → `session-runner.userMessage()` builds exactly this.
- **`Query.interrupt(): Promise<void>` exists** (the returned `Query extends AsyncGenerator<SDKMessage>`).
  **Gotcha:** interrupting **mid-tool-use** makes the SDK *throw* from `readMessages`
  (`[ede_diagnostic] … stop_reason=tool_use`) rather than ending cleanly. → `consumeStream` wraps its
  loop in try/catch and treats a throw as the session **ending** (resolves `done`, summary
  `"interrupted"`) so idle-close / `/kill` never leak a session or crash the supervisor.
- **Resume works.** `query({ options: { resume: <sessionId> } })` continues a prior session (spike: the
  resumed worker recalled the files it created). Resume keeps the **same** session id (not a fork).
- **Cost** streams per turn via `result.total_cost_usd` (cumulative); fed to `RunHandlers.onCost` and
  noted into the budget meter on completion.

The whole Phase 2 surface (live follow-ups, idle-close+resume, interrupt) is implementation-verified.

## Codex SDK adapter notes (2026-07-28)

Checked against the official Codex manual and `@openai/codex-sdk@0.145.0` package types.

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: "/path/to/project",
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
  model: "gpt-5.4",
});

const { events } = await thread.runStreamed("do the work");
```

Relevant verified TypeScript surface:

- `new Codex({ env?, config?, apiKey?, baseUrl?, codexPathOverride? })`.
- `startThread(options)` / `resumeThread(id, options)`.
- Thread options include `workingDirectory`, `sandboxMode`, `approvalPolicy`, `model`,
  `modelReasoningEffort`, `networkAccessEnabled`, `webSearchMode`, `additionalDirectories`, and
  `skipGitRepoCheck`.
- `runStreamed(input, { signal? })` yields JSON events: `thread.started`, `turn.started`,
  `turn.completed`, `turn.failed`, `item.started` / `item.updated` / `item.completed`, and `error`.
  Items include `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
  `todo_list`, `reasoning`, and `error`.

Neo wrapper behavior:

- `providers.ownWork: "subscription"` (default) keeps the Claude adapter and the existing
  `canUseTool` governor unchanged.
- `providers.ownWork: "codex"` selects the Codex adapter at `runOrder` / `startOrder`.
- Codex live sessions are implemented as sequential turns on one Codex thread: the first task starts
  a turn, `followUp()` queues later turns, `close()` resolves after the queue drains, and
  `interrupt()` aborts the active turn via `AbortSignal`.
- Codex does **not** expose Claude's `canUseTool` callback or Anthropic's in-process MCP server
  shape. Neo therefore maps read-only judge deny-lists to `sandboxMode: "read-only"` and records a
  `worker_compat_warning` event for Claude-only `RunDeps` fields (`mcpServers`, `skills`, `agents`,
  `maxTurns`, unsupported `disallowedTools`) on Codex runs.

## Resume ids are private to their SDK (verified 2026-07-31)

A `resume` id only means something to the SDK that issued it. Feeding the Claude SDK an id it does
not know (a Codex thread id, or a pruned transcript) fails locally, before any API call:

```
{ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0,
  total_cost_usd: 0, session_id: "<the id you passed>",
  errors: ["No conversation found with session ID: <id>"] }
```

…and the SDK then **throws** `Claude Code returned an error result: No conversation found …`.

Two traps this sets, both hit in production:

- There is **no `result` string and no `api_error_status`** on that message — the cause is only in
  `errors[]`. Read it, or the failure summary is empty and classifies as a generic API error.
- The failure is **not an API failure**: 0 turns, $0, nothing sent. Waiting/retrying cannot fix it;
  only starting fresh can. Neo detects it (`RESUME_MISSING_RE`), restarts cold once, and tags every
  minted id with its provider so the mismatch is prevented next time (`canResumeWith`).
