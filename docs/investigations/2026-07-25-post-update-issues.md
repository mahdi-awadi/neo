# Post-update issues — operator↔project (adminli) session

**Date:** 2026-07-25
**Scope:** live operator↔adminli Telegram session; "real issues after the last 2–3 updates."
**Method:** codebase-memory map → targeted source read → systematic-debugging (hypothesis → file:line evidence → confirm/refute). Investigation only; nothing changed, no reload.
**Commits scrutinised:** `4d90b9e` (apiError-across-turns), `7795049` (api-retry real reset), `08a4267` (reload deadline), `5c4712b` (dispatch queues instead of refusing).

The observed symptoms have **several independent causes**. Two are true regressions from the 4 commits; the rest are pre-existing architecture that the operator only now noticed (or that the new work made easier to hit). Worst first.

---

## Issue 1 — Queued operator replies are delivered ONLY at a turn boundary, never mid-turn

**Severity: HIGH.** **Regression: NO (pre-existing; the core of symptom 1).**

**Evidence.**
- Operator reply to a running project → `control.followUp(text)` → `channel.push(userMessage(text))`.
  `src/engine/pipeline.ts:193-201` (queue), `src/engine/session-runner.ts:363` (`followUp` → `channel.push`).
- The input channel is an async generator: `src/engine/session-runner.ts:292-324`.
  ```
  const iterator = (async function* () {
    while (true) {
      while (queue.length > 0) yield queue.shift()!;   // ← suspends AT the yield
      if (closed) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();
  push(msg) { if (closed) return; queue.push(msg); wake?.(); wake = null; }
  ```
- **Async-generator semantics:** after `yield N`, the generator is suspended *at that yield*. It does not run the next loop iteration until the SDK calls `.next()` again — and the SDK calls `.next()` on the prompt iterator only when it is ready for the **next input**, i.e. after it emits a `result` (turn boundary). During the in-flight turn the generator is parked at the yield, so `wake` is `null` and `push()`'s `wake?.()` is a **no-op**. The message just accumulates in `queue`.
- The test fake models exactly this lazy, one-message-per-turn pull: `tests/session-runner.test.ts:62-84` (`for await (const userMsg of args.prompt) { …yield assistant…; yield result; }`).

**Root cause.** A worker "turn" = one user message → the entire agentic loop (all tool calls, thinking) until a `result`. The SDK pulls the next queued follow-up only at that boundary. With adminli turns running 14–23 min, an operator reply waits out the **remainder of the current turn** before the worker even sees it — the reported "waits 1–3 minutes" is simply however long was left in the current turn. There is no mechanism to inject a message mid-turn (the SDK `interrupt()` exists but is used only for idle-close/kill, and it *aborts* the turn rather than injecting).

**Proposed fix (not implemented).** This is inherent to the streaming-input model; options, cheapest first:
1. **Honesty + expectation-setting (cheap):** when queueing, tell the operator the reply lands *after the current turn* and give the turn's running age, not a bare "waiting" (see Issue 2). Low effort, removes the "why is nothing happening" confusion.
2. **Bounded turns:** cap `maxTurns` for interactive sessions so the agent loop yields more often, shrinking the worst-case wait (trades off deep autonomous runs).
3. **Opt-in interrupt-and-resend for urgent replies:** a `/now <msg>` that calls `interrupt()` then re-sends the interrupted brief + the new message as the next input (reuses the api-retry `apiRetryFollowUp` re-send pattern). Only for messages the operator marks urgent, since it discards in-flight tool work.

---

## Issue 2 — The "waiting for Nm" status label is stale/dishonest during an active turn

**Severity: MEDIUM.** **Regression: NO (pre-existing).**

**Evidence.**
- The queued-reply line renders `describeSessionStatus`, which prints the **activity label** and how long it has held it: `src/engine/session-status.ts:36-40` → `${s.activity.label} for ${humanAge(now - s.activity.since)}`.
- The label is set to `"waiting"` only at a `result` (turn boundary): `src/engine/session-runner.ts:274` (`handlers.onActivity?.("waiting")`).
- `onActivity` fires for **text** (`"replying"`, line 241), **tool_use** (the tool label, line 246), **"waiting"** (line 274), and **api retry** (line 255) — but NOT for `stream_event` partial deltas, which only bump the liveness heartbeat (`onHeartbeat`, line 230). So while the worker is *thinking* at the start of a new turn (extended reasoning emits only partials before the first text/tool block), the label remains the previous turn's `"waiting"`.

**Root cause.** After the SDK pulls a queued follow-up and starts a new turn, there is a real gap — often minutes with extended thinking — where the worker is actively processing but the status still reads `running · waiting for Nm · 1 queued`. The operator reasonably reads "waiting … 1 queued" as *"it's idle and hasn't started my message,"* when in fact it is mid-thought on it. The figure is honest about *label age* but the label itself is stale, so the line misleads.

**Proposed fix (not implemented).** Set an explicit `"thinking"`/`"working"` activity when a new turn is pulled (e.g. on the first `stream_event`/`assistant` after a `"waiting"`), or render "queued — runs after the current turn (up Nm)" instead of surfacing the stale `"waiting"` label in the queued-reply notice. TDD-worthy: assert the label transitions off `"waiting"` on the first post-boundary event.

---

## Issue 3 — Worker output can arrive late, out of order, or be silently dropped (fire-and-forget sends, no Telegram flood-control)

**Severity: HIGH.** **Regression: NO (pre-existing), but it is the best explanation for the operator's "the message arrived after a while / never arrived" note.**

**Evidence.**
- Every worker line is fire-and-forget: `onMessage: (t) => { …; void deps.reply(chatId, t, project); }` — `src/engine/pipeline.ts:343-346`; identical in `src/engine/dispatch.ts:343-346`.
- `deps.reply` → `void send(cid, text, project)` — `src/frontends/telegram.ts:179-181` — and `send` → `await bot.api.sendMessage(...)` — `telegram.ts:142-148, 69-88`. Each call is an **un-awaited promise**; multiple worker lines race concurrently with **no ordering guarantee** and **no backpressure**.
- **No throttler, no auto-retry.** `grep` for `autoRetry | throttler | api.config.use | retry_after | sequentialize` across `src/` = none; `package.json:39` `"grammy": "latest"` with no `@grammyjs/transformer-throttler` / `@grammyjs/auto-retry`. grammY core does not retry HTTP 429 by default.
- On a Telegram 429 (per-chat ≈ 1 msg/s, global ≈ 30/s), `sendFormatted` catches, retries **plain text** (which also 429s), catches again, returns `undefined` → the line is **dropped silently**: `telegram.ts:79-87` ("give up silently — a dropped progress line shouldn't crash the bot").
- `operator-bus.mirror` is synchronous and non-batching (`src/engine/operator-bus.ts:46-55`), so the bus itself adds no delay — the reordering/drop is entirely in the concurrent Telegram sends.

**Root cause.** A streamed worker run emits a burst of lines (each text block, each `🔧 tool` milestone, each `🔓 auto-approved` notice) in rapid succession, all as concurrent un-awaited `sendMessage` calls to one chat. Telegram flood-control then (a) delivers them out of order (whichever HTTP call resolves first wins), and/or (b) 429s some, which are silently dropped. This matches the operator's report precisely: *"agent thought it sent the msg but it never arrived, then it got sent after a while"* — a line that lost the ordering race (or a transient network/queue delay on one send) surfaces after later lines; a 429'd line is lost entirely, reading as "no update from me." It also independently explains symptom 2's "No background update from me" if the worker's earlier update was one of the dropped/late lines.

**Proposed fix (not implemented).** Serialize + rate-limit + retry the operator send path:
1. Add `@grammyjs/transformer-throttler` (per-chat FIFO queue, honours `retry_after`) and/or `@grammyjs/auto-retry` via `bot.api.config.use(...)`. This alone gives ordering + flood-control + retry with almost no code.
2. Failing a plugin, replace the per-chat fire-and-forget with a small per-chat **send queue** (await each `sendMessage` before the next; on 429 sleep `retry_after`). Keep the plain-text fallback but never drop silently — on final failure, log with the text so it's diagnosable.
   TDD-worthy: a test that pushes N lines and asserts they are delivered in order and none dropped under a stubbed 429.

---

## Issue 4 — A typed reply cannot answer an Allow/Deny approval gate → the worker parks, the answer is swallowed

**Severity: HIGH.** **Regression: NO (pre-existing hazard; explains symptom 2's "parked waiting on your call").**

**Evidence.**
- An escalation blocks the SDK inside `canUseTool`: `await handlers.onEscalation(verdict.escalate)` — `src/engine/session-runner.ts:186`. While that promise is pending the turn is frozen mid-tool-use, so the SDK does **not** pull any queued input.
- `askApproval` resolves **only** via the inline Allow/Deny button callback: it stores the resolver in `pending` keyed by a token and posts buttons — `src/frontends/telegram.ts:183-191`; the only resolver is the `callback_query:data` handler — `telegram.ts:454-461`.
- A typed message goes the other way entirely: `bot.on("message:text")` → `routeReply` → `handleMessage` → `control.followUp` (queued into the input channel) — `telegram.ts:246-324`, `pipeline.ts:196`. There is **no bridge** from a typed message to a `pending` approval resolver.

**Root cause.** If the operator answers an approval prompt (or a clarifying question that happened to be gated) by **typing** instead of tapping Allow/Deny, the typed text is queued as a follow-up that the SDK will never pull (it is blocked awaiting the approval promise), and the approval promise never resolves. The worker is genuinely parked and the operator's answer is effectively swallowed. (Note: `AskUserQuestion` is governor-denied so plain clarifying questions come as text, not a gate — but any *risky-tool* escalation on a non-trusted action reproduces this. adminli auto-approves risky shell today, so this bites when a non-auto-approvable escalation fires, e.g. an out-of-folder write or WebFetch.)

**Proposed fix (not implemented).** When an approval is pending for a chat, treat the operator's next plain-text message as the decision (map "yes/approve/allow" → allow, "no/deny" → deny, anything else → re-prompt), the same way `pendingInboxEdit` already captures the next message (`telegram.ts:251-264`). Alternatively, surface a visible "⚠️ waiting for you to tap Allow/Deny" reminder and refuse to queue follow-ups while a gate is open. TDD-worthy.

---

## Issue 5 — A non-reply operator message routes to the COMPANY when focus is unset/consumed → cross-talk

**Severity: HIGH.** **Regression: NO (pre-existing; the core of symptom 3).**

**Evidence.**
- `routeReply` only pins focus when the message is an actual Telegram quote-reply (`replyToMessageId` set): a non-reply passes straight through — `src/engine/reply-routing.ts:55` (`if (input.replyToMessageId === undefined) return { deliver: input.text }`).
- The pipeline then routes by focus, defaulting to the company/default session: `src/engine/pipeline.ts:188-189` (`const live = focus?.session ?? registry.getDefault()`).
- Focus set by a reply is **one-shot** (`"once"`) and consumed on delivery — `reply-routing.ts:66,90` (`setFocus(...,"once")`), `pipeline.ts:191,198` (`oneShot` cleared after delivering).

**Root cause.** The operator's project session is held by *one-shot* focus. If they answer the worker by typing a new message **without** quote-replying (or after focus was consumed), it falls through to `registry.getDefault()` — the **always-on company session** — not adminli. The company worker then receives an answer meant for adminli (cross-talk), and adminli keeps waiting. Symmetrically, worker output always streams to the session's original `chatId` tagged `#adminli`, so the *questions* land in the right DM — but the *answer* can land on the company. This is exactly "a reply landing on the company instead of the project."

**Proposed fix (not implemented).** For an interactive project conversation, prefer `"pinned"` focus (auto-`/pin` on first reply into a project, auto-revert on an explicit `/company` or after idle) so consecutive typed answers stay with the project without a quote-reply each time. Keep the existing `clarify` guard for genuinely ambiguous cases. Verify against `tests/reply-routing.test.ts`.

---

## Issue 6 — `7795049` can park the worker for hours on a transient throttle (over-eager reset backoff)

**Severity: HIGH.** **Regression: YES — introduced by `7795049`.**

**Evidence.**
- `resolveApiRetryDelayMs` treats a window as "governing" if it merely carries a future reset and its status is not exactly `"allowed"`:
  `src/engine/api-retry.ts` — `const future = (rateLimits ?? []).filter(r => typeof r.resetsAt === "number" && r.resetsAt*1000 > now && r.status !== "allowed")`, then `base = soonest.resetsAt*1000 - now` with **no cap**.
- `RateLimitInfo.status` values are `allowed | allowed_warning | rejected` — `src/engine/usage.ts:32-35`. So `"allowed_warning"` (near-limit but **still allowed**) and any window with an **undefined** status pass the `!== "allowed"` filter.
- Wired live: the interactive session passes the full `rateLimits` snapshot into the retry — `pipeline.ts:374-380`, `dispatch.ts:367-373`.

**Root cause.** When a turn fails on a brief, per-minute burst, the soonest per-minute window may have already flipped back to `status:"allowed"` (filtered out), leaving a long-horizon window — a 5-hour or 7-day plan window in `"allowed_warning"`, or one with no status — as the "soonest governing" window. The backoff then waits until *that* window's reset: **hours to days**, uncapped, with the run held open (`retryingUntil` set, stall/ceiling clocks paused — `dispatch.ts:376-383`; `pipeline.ts:381-384`). The operator sees "⏳ auto-resuming at <UTC>" and the worker sits parked far longer than the actual throttle required. The pre-`7795049` ladder (30s→2m→8m) never did this. This is a strong candidate for long unexplained "parked" stretches after the update.

**Proposed fix (not implemented).** Tighten the filter to genuine rejections (`r.status === "rejected"`, or a utilization threshold), ignore `"allowed_warning"`/status-less windows for backoff selection, and **cap** the reset-based delay (e.g. `min(resetDelay, ladderCeiling×k)`) with a fallback to the ladder when the only governing window is a long-horizon one. Cover with an `api-retry.test.ts` case: an `allowed_warning` 5h window + a recovered per-minute window must not yield a 5h delay.

---

## Issue 7 — `5c4712b`: a company dispatch queued into a live session interleaves with the operator and its result is never returned

**Severity: MEDIUM.** **Regression: YES — introduced by `5c4712b`.**

**Evidence.**
- The new busy-branch pushes the company's brief into the **same** input channel the operator uses and returns immediately: `src/engine/dispatch.ts:250-261`
  ```
  if (control?.followUp) {
    control.followUp(order.task);
    await deps.reply(replyChat, `→ queued for ${name} (busy): ${task}`, name);
    return (`${name} is busy — I queued this brief behind its current turn …`);
  }
  ```
- It does **not** await `run.done`, so unlike the normal dispatch path (`dispatch.ts:491` `[dispatch result] …`) the queued brief's completion is **never** routed back to the company as a follow-up. The brief runs inside the operator's live adminli session, and its output streams to that session's original `chatId` (the operator), tagged `#adminli` — mixed into the operator's own thread.

**Root cause.** Before `5c4712b` a company dispatch to a busy folder refused; now it silently merges a company-authored brief into the operator's live worker queue. Two consequences: (1) the company's task and the operator's task share one worker/one context and interleave in push-order, which the operator can perceive as the worker "doing something I didn't ask" or answering the wrong thing; (2) the company believes it dispatched work but will never receive a result (it only got "queued"), so any company-side logic awaiting the dispatch result waits forever. This is a plausible contributor to symptom 3's cross-talk between company and project.

**Proposed fix (not implemented).** Either (a) keep queueing but wire the queued brief's completion back to the company (await/observe `run.done` for that brief and emit `[dispatch result]` as today), and clearly tag company-originated turns in the operator stream; or (b) only queue when the target session's chat *is* the company's, and otherwise keep the informative refusal. Extend `tests/dispatch.test.ts` to assert a result is reported for the queued path.

---

## Regression checks — cleared

**`4d90b9e` (apiError across turns) — CORRECT, no regression.**
`src/engine/session-runner.ts:259-277`: `turnError = failed ? (apiError ?? fromStatus) : undefined` gates the reported error on **this** turn failing; `onTurnComplete` is called on **every** `result` (line 275) regardless, so it cannot suppress a turn-complete or swallow a follow-up; `apiError = undefined` reset per turn (line 277) prevents the cross-turn leak; the final return uses `lastApiError` (this turn only). For a normal completion the live-session handler does nothing but keep the session open (`pipeline.ts:364-365` returns when `!kind`). No false failure, no swallow.

**`08a4267` (reload deadline) — LOW risk, not implicated.**
The failsafe `setTimeout(() => process.exit(1), shutdownFailsafeMs(...)).unref()` is armed **only inside `drain()`** on an actual reload (`src/daemon.ts:83-90`), and `handleMessage` refuses new work only while `lifecycle.draining()` (`pipeline.ts:159-162`), which is set by `beginDrain()`. There is no path where normal (non-reload) messages are delayed/refused by this change, and the force-exit guarantees `draining` can't get stuck true without the process exiting. Unrelated to the adminli symptoms unless a reload was mid-flight.

---

## Summary of attribution

| # | Issue | Severity | Regression from the 4 commits? |
|---|-------|----------|--------------------------------|
| 1 | Follow-ups delivered only at turn end (long-turn latency) | HIGH | No — pre-existing |
| 2 | "waiting Nm" label stale during active turn | MED | No — pre-existing |
| 3 | Late/out-of-order/dropped worker sends (no throttle/retry) | HIGH | No — pre-existing (best fit for the "arrived after a while" note) |
| 4 | Typed reply can't answer Allow/Deny gate → parked | HIGH | No — pre-existing hazard |
| 5 | Non-reply answer routes to company (focus one-shot) | HIGH | No — pre-existing |
| 6 | Reset backoff parks worker for hours on transient throttle | HIGH | **Yes — `7795049`** |
| 7 | Queued company dispatch interleaves + result never returned | MED | **Yes — `5c4712b`** |
| — | `4d90b9e` apiError reset | — | Cleared (correct) |
| — | `08a4267` reload failsafe | — | Cleared (not implicated) |
