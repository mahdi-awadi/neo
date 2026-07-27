# Approval channel dies mid-session — `Tool permission request failed: Error: Stream closed`

**Date:** 2026-07-27
**Branch:** `feat/engine-event-log` (not merged to master; this fix lands here and uses its event log)
**Method:** codebase-memory map → SDK-internals read (`node_modules/@anthropic-ai/claude-agent-sdk` `0.3.183`) → systematic-debugging (evidence before fix) → TDD.
**Observed (live):** during a long `frontend-backend` team dispatch, every file-mutating tool call (Edit / Write / MultiEdit, non-allowlisted Bash) began failing with `Tool permission request failed: Error: Stream closed`. Only pre-allowlisted trivial Bash still passed. Tools worked earlier, then degraded partway through; operator correlated it with MCP server reconnect churn. The team shares the channel, so all writers were blocked.

---

## How the approval path is wired

`SDK query()` ← `sdkOptions.canUseTool = buildCanUseTool(handlers, folder)` (`src/engine/session-runner.ts`).
`buildCanUseTool` → `decide()` (`src/engine/governor.ts`, default-ESCALATE + path-fence) → on an escalate verdict, either `handlers.autoApprove()` (trust) or `await handlers.onEscalation()` → `deps.askApproval()` (Telegram Allow/Deny buttons — `src/frontends/telegram.ts:183-191`; dispatched/autonomous paths auto-deny).

The SDK talks to the CLI **worker subprocess** over a stdio control protocol (`sdk.mjs`):

- CLI → parent (**stdout**): assistant/tool messages **and** `can_use_tool` control_requests.
- parent → CLI (**stdin**): our follow-up user messages **and** the `control_response` carrying each permission decision.

`handleControlRequest` calls our `canUseTool`, then `this.transport.write(control_response)` back over stdin. The transport `write()` guards (verified in `sdk.mjs`):

- `if (this.processStdin.writableEnded) { "Dropping write to ended stdin stream"; return }` — the response is **silently dropped**.
- a failed `processStdin.write` does `this.ready = false` **permanently** → every later write throws `"ProcessTransport is not ready for writing"`.
- if writing the decision throws, `handleControlRequest` tries an error-response write; if that also throws it logs `"Error-response write failed"` and **sends nothing**.

## Root cause (two layers)

1. **SDK transport (origin of the literal `Stream closed`).** The string is **not** in our code nor in `sdk.mjs` — it is emitted by the CLI subprocess when its permission round-trip to the parent can't complete because the parent→CLI **stdin** control channel is ended/not-ready. stdout stays alive, so the session keeps running and keeps attempting tools — exactly the observed shape (session alive, every gated tool fails, pre-approved ones pass). The SDK does **not** re-establish the transport → dead without recovery. This is SDK-internal; the engine cannot re-open that stream from inside `canUseTool`.

2. **Engine bridge had no fail-safe (fixed here).** `buildCanUseTool` did `await handlers.onEscalation(...)` with **no try/catch**. When the approval round-trip *rejects* (a closed/torn-down channel — the same failure class), the callback **rejects**. The SDK turns a rejected `canUseTool` into an ungoverned permission error (`{subtype:"error"}`), and because nothing recovers, every subsequent risky tool rejects identically — an engine-side "dead without recovery" on top of the transport one. Auto-allowed in-folder writes skip escalation, so this layer specifically governs the escalating tools (MultiEdit is unrecognized → escalate; risky Bash → escalate; out-of-folder writes → escalate).

## Fix

`buildCanUseTool` (`src/engine/session-runner.ts`) now wraps the entire decision path so the callback **can never reject**. Any failure (onEscalation rejecting, or an unexpected throw) **fails safe to a governed `deny`** per default-escalate policy — never a thrown/hung callback, never a silent auto-approve (no hole; path-fence and default-escalate untouched). It records an `approval_error` event (event-log branch) so a dead channel is visible. The wrapper is stateless per call, so once the channel is healthy the next tool call escalates normally — **self-heal**; a transient break can no longer permanently wedge approvals.

Covered by `tests/approval-resilience.test.ts` (fail-safe deny · no hole · event surfaced · self-heal on recovery). TDD: RED first (rejection propagated out of the callback), then GREEN.

## Scope / follow-up (not done)

- The engine cannot repair a genuinely dead SDK stdio transport (layer 1) from `canUseTool`. The durable recovery is **session-level**: detect a persistently broken permission channel and recycle (interrupt + resume → fresh subprocess → fresh stdin). Detection wants a `user`/`tool_result` branch in `consumeStream` (the known tool-result streaming gap, see `HANDOFF.md`) to observe the CLI's failure; deferred rather than built on an unverified message shape.
- `MultiEdit` is absent from the governor's `FENCED_TOOLS`/`SAFE_TOOLS`, so it hits default-escalate rather than the path-fence. Worth adding to `FENCED_TOOLS` (path-fenced like Write/Edit) — noted, not changed here.

## Reload

Landing this needs a daemon reload to take effect (worker sessions read the new callback at start). **Report only — do not reload without operator permission.**
