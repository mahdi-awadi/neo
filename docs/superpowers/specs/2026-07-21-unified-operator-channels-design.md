# Unified operator channels (Telegram + web mirror) — design

**Date:** 2026-07-21
**Status:** approved (operator picked scope Option 2; confirmed visibility-only unification + `admin.adminId()` mirror target)

## Problem

Today each operator frontend only delivers on its own transport. If the operator chats via Telegram,
the web console shows nothing (and vice-versa) — no shared visibility of the conversation or streamed
progress. Both frontends are already `source:"neo"` operator channels sharing the
registry/meter/ledger/admin, and the ledger already records the full transcript, but there is **no
live cross-channel push**.

## Goal

One mirrored operator conversation across Telegram + the web console:

1. Neo's replies **and** streamed worker progress appear on **both** surfaces, regardless of which
   channel the operator's message came from.
2. The operator's **own** inbound message is echoed to the other surface(s), attributed as theirs, so
   both surfaces show the full thread.
3. **Also** route scheduled-loop output (today Telegram-only) through the same bus so the web console
   sees loop activity too. (Scope Option 2.)

**Explicitly out of scope (this pass):** inbox / customer-draft progress stays on its current channel
(customer-firewall path); the bus makes adding it later ~one line. Routing / one-shot focus stay
per-surface — this is visibility-only unification, not focus unification.

## Current model (verified in code)

- `daemon.ts` creates the shared `registry`/`meter`/`ledger`/`admin`/`trust`/`usage`, then starts two
  independent frontends, each injecting its own `reply`/`askApproval` into `pipeline.handleMessage`:
  - **Telegram** (`frontends/telegram.ts`): `reply` → `send(chatId,…)` → `bot.api.sendMessage`;
    approvals are inline Allow/Deny buttons resolved via a `pending` token map; inbound is
    `bot.on("message:text")`.
  - **Web** (`engine/web-channel.ts` + `frontends/web.ts`): `reply` → `message()` →
    `emit({type:"message"})` fanned to SSE listeners; approvals emit `{type:"escalation"}` resolved via
    `POST /approve`; inbound is `POST /msg` → `channel.send()`.
- Chat ids differ: Telegram uses the real chat id; web uses `WEB_CHAT_ID = 0`. Focus/routing/
  `recordMessage` are keyed by chatId, so the two surfaces are separate chats today.
- The admin's Telegram DM chat id == `admin.adminId()` (the loop scheduler already uses it).
- Delivery is already fault-tolerant: `sendFormatted` swallows Telegram errors; web `message`/`notify`
  buffer into `events[]` even with zero SSE listeners.

## Design

### A. The bus — `src/engine/operator-bus.ts` (new, pure, no AI)

```ts
export type BusLine =
  | { kind: "reply";  text: string; project?: string }  // Neo output / worker progress
  | { kind: "echo";   text: string }                     // operator's own inbound, from another surface
  | { kind: "notice"; text: string };                    // display-only (e.g. approval pending)

export interface OperatorSink {
  id: string;                    // "telegram" | "web" — the origin tag
  deliver(line: BusLine): void;  // render on this surface; MUST NOT re-enter the pipeline
}

export interface OperatorBus {
  register(sink: OperatorSink): () => void;       // returns an unregister fn
  mirror(originId: string, line: BusLine): void;  // fan out to every sink EXCEPT originId
}
```

`mirror(originId, line)` delivers `line` to every registered sink whose `id !== originId`, each call
wrapped in try/catch so a dead/throwing sink never blocks the others. `register` returns an
unregister function; a sink id may register at most once (a re-register replaces).

### B. No-feedback-loop invariant (critical)

- **Sinks are output-only.** `deliver` renders and returns — it has no path to `handleMessage`. A
  mirrored line can never become an order, and nothing inside `deliver` calls `mirror`. The bus never
  subscribes to its own output. Re-ingestion and infinite re-broadcast are **structurally
  impossible**, not merely avoided by convention.
- **Origin exclusion = de-dupe.** The origin surface already displayed the content locally, so
  `mirror` pushes only to the others — exactly once each.
- Only the two genuine inbound handlers (`bot.on("message:text")`, `POST /msg`) call `handleMessage`.

### C. Wiring (Option 2)

| Trigger | Origin path (unchanged) | Mirror |
|---|---|---|
| Neo reply / worker progress | origin's `reply` delivers locally | `mirror(origin,{kind:"reply"})` → other surface |
| Operator inbound (conversational) | `handleMessage(...)` on origin | `mirror(origin,{kind:"echo"})` → other surface |
| Scheduled-loop output | daemon `sendOperatorLine(...)`→Telegram (+stdout fallback) | `mirror("telegram",{kind:"reply"})` → web only |

- The reply/echo closures **keep delivering locally exactly as today**, then add one `mirror(...)`
  call — the origin path is untouched; the bus is purely additive.
- Slash-commands that resolve synchronously are **not** echoed (their reply already mirrors); only
  real conversation/orders echo.
- Loop output uses origin `"telegram"` because `sendOperatorLine` already delivered to Telegram — so
  the mirror reaches the web sink only, no double-Telegram.

**Telegram sink** — delivered to `admin.adminId()` (the DM chat). Extracted as a pure
`makeTelegramSink({ adminId, reply, plain })` so it is unit-testable without a live Bot:
- `reply` → `reply(adminId, text, project)` (the existing project-tagged `send`)
- `echo` → `plain(adminId, "🌐 you (web): " + text)` (operator's own message from the web)
- `notice` → `plain(adminId, text)`
- `adminId()` undefined → no-op (nothing claimed yet).

**Web sink** — registered inside `createWebChannel`:
- `reply` → `message(text, project)` (reuses the existing markdown→HTML emitter; lands in the SSE
  replay buffer, so a reconnecting client sees the full thread)
- `echo` → `emit({type:"echo", text})` (rendered as a `me` row client-side)
- `notice` → `emit({type:"notice", text})`.

New `WebEvent` variants: `{type:"echo"; text}` and `{type:"notice"; text}`; `consolePage()` renders
echo as a `me` row and notice as a subtle system line.

### D. Approvals across channels

The actionable prompt stays on the **origin** channel (Telegram inline buttons / web `POST /approve`).
The other surface gets a display-only `notice`:

- on ask: `"⏳ approval pending on <other surface>: <reason>"`
- on resolve: `"approval <allow|deny> on <other surface>"`

So both surfaces *see* a pending gate; only the origin can action it. Cross-channel resolution would
couple the two resolver maps for little gain — deferred.

### E. Extensibility seam (noted, not built)

Inbox / customer-draft progress can be mirrored later by adding a single `mirror("web", {kind:"reply",
…})` in the web `notify` path and `mirror("telegram", …)` in the Telegram `briefDeps` path. Left out
here on purpose — it is the customer-firewall path and stays separate.

## Testing (TDD — failing test first per piece)

1. **bus** (`tests/operator-bus.test.ts`): mirror hits all sinks except origin; only-origin-registered
   → nobody, no throw; a throwing sink doesn't block others; unregister removes a sink.
2. **web-channel** (`tests/web-channel.test.ts`): a bus `reply` line (origin telegram) emits a
   `message` event; `echo` → `echo` event; `notice` → `notice` event; the web `reply` closure mirrors
   a `reply` to the bus (origin `web`); inbound `send()` of a conversational message mirrors an `echo`,
   but a `/command` does not.
3. **telegram sink** (`tests/telegram-sink.test.ts`): `makeTelegramSink` routes reply→reply(adminId,…),
   echo→plain(adminId,"…you (web)…"), notice→plain; no adminId → no-op.
4. **loop mirror** (`tests/loop-mirror.test.ts`): the daemon's loop-reply helper mirrors a `reply` to
   the bus (origin telegram) so the web sees loop output.

`bunx tsc --noEmit` + `bun test` green; commit per logical piece on `master`; no push/deploy.

## Files touched

- **new** `src/engine/operator-bus.ts`, `tests/operator-bus.test.ts`
- `src/engine/web-channel.ts` (+ `tests/web-channel.test.ts`)
- `src/frontends/telegram.ts` (+ `tests/telegram-sink.test.ts`)
- `src/frontends/web.ts` (thread the bus + render `echo`/`notice` in `consolePage()`;
  `tests/console-page.test.ts`)
- `src/daemon.ts` (create the bus once; pass to both frontends; mirror loop output;
  + `tests/loop-mirror.test.ts`)
