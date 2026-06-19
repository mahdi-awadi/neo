# Claude Agent SDK — verified notes (Phase 0 spike)

Verified against `@anthropic-ai/claude-agent-sdk@0.3.183` on 2026-06-19 by running
`src/spike.ts` (now deleted). Phase 1 builds on this.

## Entry point

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
for await (const msg of query({ prompt, options })) { /* ... */ }
```

`query()` returns an async generator of `SDKMessage`. Runs in a **plain bun process — no
terminal, no TTY, no tmux**. Confirmed headless.

## Options that matter for Neo (all verified working)

- `cwd: string` — the project folder the worker opens ("open the project").
- `settingSources: ["project"]` — **loads the folder's `CLAUDE.md` (+ `.claude/` settings, `.mcp.json`).**
  Confirmed: the worker read the seeded CLAUDE.md and followed its rule.
- `systemPrompt: { type: "preset", preset: "claude_code" }` — full Claude Code behavior.
- `permissionMode: "default"` — sends non-pre-approved tools through `canUseTool`.
- `maxTurns: number` — bounds the agentic loop.
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
- `"assistant"` — `msg.message.content` is an array of blocks; text is `block.type === "text"` →
  `block.text`.
- `"result"` — terminal; `subtype: "success"`, plus `total_cost_usd`, `num_turns`. Read the final
  outcome here.

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
