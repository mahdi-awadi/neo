# Structured questions + styled/colored operator messages — design

Date: 2026-09-03. Branch: `feat/structured-questions-and-styled-messages` (off
`feat/priority-decisions-secretary`). Two related features about how operator Telegram messages
look and how the engine asks the operator questions. Deterministic, AI-free, TDD.

## Feature 1 — first-class structured-question path

Today a worker's only structured-question path is the `ask_operator` MCP tool (single question,
flat options). The SDK's native `AskUserQuestion` tool is hard-denied by the governor with "Neo has
no structured-question UI", so the company/interactive sessions have no working structured ask.

Goal: service structured questions through the EXISTING decisions machinery (openDecision →
postDecision → tap/reply resolves + resumes), not a parallel system.

- New pure module `src/engine/structured-question.ts`: `StructuredAsk` (1..4 questions, each with
  2..5 short option labels + optional `multiSelect`), normalization, callback encode/decode
  (backward-compatible with the legacy `dec:<id>:<idx>`), a pure selection reducer (`applyTap`,
  `isComplete`, `needsSubmit`, `answerText`), and a pure keyboard spec (`keyboardRows`). All logic
  lives here (tested); the frontend stays thin I/O.
- Ledger `decisions` gains a nullable `spec` JSON column holding the `StructuredAsk`. The flat
  `options` path is untouched (legacy single-select + escalations keep today's exact one-tap UX).
- `ask_operator` gains an optional `multiSelect` flag → builds a single-question `StructuredAsk`.
- The native `AskUserQuestion` tool is SERVICED (not hard-denied) whenever a new
  `RunHandlers.onStructuredQuestion` hook is wired: `buildCanUseTool` parses its input into a
  `StructuredAsk`, raises the tracked decision (buttons on the Decisions channel), and denies the
  tool with the same "check-point + STOP, your answer resumes you" message `ask_operator` returns.
  When the hook is absent (bare worker / customer/ingress path) it falls back to today's plain
  steer — so customer-tainted work still cannot raise a decision (firewall by construction).
- One shared `raiseOperatorDecision(deps, params)` helper behind both `ask_operator` and the hook.
- Frontend: `postDecision` renders the structured keyboard when `spec` is present; taps accumulate a
  per-decision selection (in-memory, ephemeral — the decision row stays durable), a single
  single-select question resolves on one tap (today's UX), multi-select / multi-question show a
  `✅ Submit`; the implicit `✏️ Other` free-form path is unchanged.

Scope note: the selection-in-progress is held in memory, so a daemon restart mid-selection loses the
partial picks — the decision stays OPEN and re-renders fresh on the next tap. Acceptable (documented).

## Feature 2 — styled + colored messages

Telegram has no text colors, so "color" = a consistent accent-emoji + label system keyed by the
existing deterministic priority.

- One central, data-driven map in `priority.ts`: `PRIORITY_STYLES` (decision 🔵, alert 🔴, done 🟢,
  progress = silent — deliberately unbadged so the streamed firehose reads as today), plus
  `priorityStyle(p)` and `styleLine`/`accentPrefix`. `priorityBadge` is refactored to derive from the
  map (its existing test stays green).
- Applied at each surface's formatting boundary: Telegram `sendFormatted` prepends the accent (before
  the `#project` tag), web-channel `deliver` prepends it too — both via the same pure function, so
  both surfaces render consistently. The accent is plain emoji text, so it degrades gracefully where
  rich markup is not supported (the existing plain-text fallback in `deliverChunked` still applies).
- Redundant per-call-site glyphs are removed where the accent now carries the meaning: the pipeline's
  `✓/✗` completion line and the dispatch `✅/⛔` completion line emit the bare summary + priority; the
  frontend adds the single accent ("not hardcoded per call-site").
- Escaping: the existing HTML `parse_mode` path already HTML-escapes bodies and falls back to plain
  text if Telegram rejects the markup, so a message full of metacharacters always sends. A test
  proves it (a styled line with Markdown/HTML metacharacters still delivers via the plain fallback).

Note: the repo sends via Telegram `parse_mode: "HTML"` (see `format.ts` `mdToHtml`), NOT MarkdownV2.
The task brief says "MarkdownV2"; we honor the intent (correct escaping + graceful plain-text
fallback + a metacharacter test) on the actual HTML path rather than rewrite the whole formatter.
