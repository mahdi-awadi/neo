# Session focus + real status + company awareness — design

**Date:** 2026-07-16
**Status:** approved (operator delegated the focus UX: "pick the cleanest UX and document it")

## Problem (operator, verbatim intent)

1. "Never tell me a project is busy and I don't know the status." A blocked message/dispatch
   returns an opaque *"project is busy"* — no idea what it's doing or when it frees.
2. "The main agent should also be aware of that." The company/default agent has no visibility into
   other projects' session states; it just gets *"still busy"* and can't tell the operator what's up.
3. "I send messages to other projects by mistake all the time because they're active." Talking to a
   project leaves that project the active target, so the *next* (unrelated) message lands on it.
4. Desired: "Keep a project active only for one message, then move it back to the main agent."

## Current model (verified in code)

- `registry.findByChat(chatId)` returns the explicitly-selected active session **or falls back to
  the most-recently-active OPEN project for that chat** (`registry.ts` `active` map + sort). So
  `/open`, `/use`, tapping a project, or replying to its message all leave that project *sticky*.
- `pipeline.handleMessage` routes a plain message to `findByChat(chatId) ?? getDefault()` — the
  company (`chatId:-1`) is only the fallback.
- The company's `dispatch` tool returns a bare `"<name> is still busy…"` (`dispatch.ts`), and nothing
  exposes live session states to the company session.

## Design

### A. One-shot project focus (default target is always the company)

Replace the sticky `active` map with an explicit **per-chat focus that carries a mode**:

- `type FocusMode = "once" | "pinned"` on the registry.
- `setFocus(chatId, id, mode)`, `clearFocus(chatId)`, `getFocus(chatId): { session, mode } | undefined`
  (returns only while the focused session is still OPEN).
- `findByChat(chatId)` now returns **only the focused session** (if OPEN) — it no longer falls back to
  the most-recently-active project. So `pipeline`'s `findByChat(chatId) ?? getDefault()` routes to the
  **company by default**.

Routing (`pipeline.handleMessage`, plain text): resolve `focus = getFocus(chatId)`; deliver to
`focus?.session ?? getDefault()`. If `focus.mode === "once"`, `clearFocus(chatId)` once the message is
actually committed (after `followUp` for a running project; after passing the resume guard for an idle
one) — so the very next message reverts to the company. `pinned` focus persists.

Because `findByChat` no longer falls back, **`/open <folder> <task>` is one-shot by construction**: it
delivers its task to the project, and the next plain message goes to the company. Nothing extra needed.

**Operator UX:**
- `/use <name>` — address a project for your **next message only**, then it reverts to the company.
- `/pin <name>` — keep talking to that project until you unpin (multi-turn).
- `/unpin` (alias `/company`, `/main`) — return focus to the company now.
- Tapping a project in `/list`, and replying to a project's worker message, both set **one-shot** focus.
- `/list` marks the focused project (`▶` once, `📌` pinned); with none focused, the company is the target.

### B. Real status instead of opaque "busy"

New pure module `engine/session-status.ts`:
- `humanAge(ms)` (moved here; `commands.ts` imports it — single source).
- `describeSessionStatus(s, now, { queued?, ctxPct? })` → e.g. `running · editing files for 2m · 1 queued`
  / `idle · last active 5m ago`. Mirrors how `/list` already renders activity.
- `sessionStatuses(registry, now)` → one view row per OPEN session **excluding the company**, each with
  its `describeSessionStatus` line (backs the `sessions` tool below).

Use it at the blocked-status sites:
- Company `dispatch` busy return: `"<name> is busy — <status>. I did not start this dispatch; its
  current work must finish first…"` (the company can relay the real status and decide wait-vs-report).
- Operator follow-up queued onto a running project: reply `"↩︎ queued for <name> — <status>"` instead
  of a bare `"added to <name>"`.

### C. Company session awareness

Add a company-only **`sessions` MCP tool** (same gate as `dispatch`, in `neoMcpServers`) that returns
`sessionStatuses(...)` as text — the company calls it to answer "what's X doing?" and to decide
wait-vs-report when a dispatch is busy. Deterministic; no AI added to the engine.

## Boundaries / non-goals

- Dispatch still **refuses** (does not queue) a second brief onto a busy folder — but now with real
  status, not an opaque string. Cross-dispatch queueing is out of scope (YAGNI).
- Focus is per-`chatId`, so Telegram (operator chat) and the web console (chat `0`) stay independent;
  both default to the company. The firewall, governor, budget guard, and dispatch liveness are untouched.

## Tests

- `session-status.test.ts`: `describeSessionStatus` running/idle/queued formats; `sessionStatuses`
  excludes the company and reflects activity.
- `registry.test.ts`: `findByChat` returns only the focused session (no most-recent fallback);
  `setFocus`/`getFocus` mode; one-shot vs pinned; focus drops when the session closes.
- `pipeline.test.ts`: one-shot delivery then revert-to-company; pinned persists; busy reply includes status.
- `commands.test.ts`: `/use` one-shot, `/pin`, `/unpin`, and the `/list` focus marker.
- `dispatch.test.ts`: busy return contains the live status; `sessionStatuses` shape.
