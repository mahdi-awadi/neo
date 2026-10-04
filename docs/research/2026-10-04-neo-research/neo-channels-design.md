# Neo channels: Telegram as one channel among many, plus a visual "tap, don't type" channel

**Date:** 2026-10-04 · **Status:** design proposal, nothing built · **Repo:** `mahdi-awadi/neo` @ `60b87b9`
**Sources:** Neo's code (cited as `file:line`) and the research notes in
[`channels-research-notes.md`](channels-research-notes.md) (every external claim there carries a source URL and a confidence tag).

---

## 1. The short version

**Before:** Neo has two operator surfaces, Telegram and the web console, and each one rebuilds the
whole operator conversation by itself: its own pipeline wiring, command handling, loop buttons, inbox
buttons and approval map. Messages are plain text lines. An approval can only be answered on the
surface that asked. The daemon calls the Telegram HTTP API directly for alerts. The web console can
only be logged into with Telegram. Workers are forbidden from asking multiple-choice questions, so
every question becomes a paragraph you answer by typing.

**After:** the engine owns **one operator conversation** made of **typed events** (message, progress,
card, file, notice). Telegram, the web app, push notifications, email and anything later are thin
**channel adapters** that render those events with whatever their platform can do and send back
**actions** (a tap, a typed reply, a voice note). Any channel can answer any approval. A new channel,
**Neo Deck**, is an installable web app (and the same page as a Telegram Mini App) built around cards
and buttons: a "needs you" queue, live project tiles, one-tap approvals, multiple-choice questions,
suggested next steps as chips, saved order templates, and a mic button.

The two halves are one design: the channel layer is what makes the visual channel cheap, because the
cards Neo Deck shows are the same events Telegram renders as inline keyboards.

---

## 2. What ties Neo to Telegram today (verified in code)

| # | Coupling | Where | Why it matters |
|---|---|---|---|
| 1 | Each frontend builds its own `PipelineDeps` and re-implements command, loop, inbox and callback dispatch | `src/frontends/telegram.ts:166-470`, `src/engine/web-channel.ts:48-200` | Every new channel means a third copy of ~400 lines. Features drift (web has loop CRUD, Telegram doesn't). |
| 2 | The cross-surface bus only carries text: `reply`, `echo`, `notice` | `src/engine/operator-bus.ts:14-17` | No way to send a card, a question, or a progress update that edits in place. |
| 3 | An approval is only actionable on the surface that raised it; others see "pending on Telegram" | `telegram.ts:183-191`, `web-channel.ts:131-138`, spec `2026-07-21-unified-operator-channels-design.md` §D | If the ask went to Telegram and you're on the web console (or a phone notification), you can't answer. |
| 4 | Daemon alerts bypass any channel and `fetch` the Telegram API directly | `src/daemon.ts:149-156` (watchdog), `src/daemon.ts:190-197` (loop failure), `daemon.ts:115` (loop output via `sendOperatorLine`) | Alerts can't go to push, email or the web unless they're re-plumbed one by one. |
| 5 | Identity is Telegram: admin is claimed by the first Telegram message; web login is the Telegram Login Widget; without a bot token the web console is disabled | `telegram.ts:164-165`, `src/frontends/web.ts:61,322-346`, `daemon.ts:239` | Neo can't run without Telegram at all. |
| 6 | Routing and focus are keyed by `chatId` (Telegram's real id, web = `0`) | `src/engine/registry.ts:57`, `web.ts:19` | "Which project am I talking to" is per surface, so switching device loses context. |
| 7 | Structured questions are denied: "Neo has no structured-question UI" | `src/engine/governor.ts:49-55` | The single biggest source of typing: workers can't offer options, so you type answers. |
| 8 | Sends are fire-and-forget with no queue, so lines drop or reorder under Telegram's rate limit; a typed reply can't answer an Allow/Deny | `docs/investigations/2026-07-25-post-update-issues.md` Issues 3 and 4 | These are channel-layer bugs. Another thread is fixing them inside `telegram.ts` now; this design moves the fix into the shared layer so every channel gets it. |

What is already good and stays: the engine has no AI, the bus's output-only rule (a mirrored line can
never become an order), `CommandResult` already carries structured `select` / `inbox` rows
(`src/engine/commands.ts:56-63`), and the customer side (`gateway/`, Go, Gemini) is already separate.

---

## 3. What other agents do (the parts worth copying)

Full notes with links: [`channels-research-notes.md`](channels-research-notes.md).

- **Adapters are small; the core owns delivery.** Hermes Agent: `connect`, `disconnect`, `send → {success, message_id}`, optional typing/interrupt; inbound normalised into one `MessageEvent`; 25+ platforms including ntfy; a per-platform feature matrix documents what degrades. OpenClaw: the core owns queueing, durable ingress and drain; the plugin owns native send/edit/delete and threading.
- **One card model, graceful degradation.** Rasa requires only `send_text_message`; buttons and images fall back to text automatically. Vercel Chat SDK renders one JSX `Card` natively on Slack/Teams, as markdown on Discord, as ASCII elsewhere.
- **Approvals are first-class or they break.** OpenClaw's tracker has a long run of Telegram approval bugs (buttons missing, clicks silently dropped, prompts in the wrong topic). LangGraph Agent Inbox models a human decision as four verbs, `accept | edit | respond | ignore`, with per-request flags for which are allowed. Adaptive Cards replace the card in place after a click so it shows the outcome.
- **A durable delivery ledger.** Hermes and OpenClaw both record every outbound send and redeliver at least once. Hermes also has a silence token (`NO_REPLY`) and a "home channel" for cron results and alerts.
- **Telegram can do much more than Neo uses.** Coloured buttons (`style: success | danger | primary`, Bot API 9.4), disabled buttons and rich messages (10.x), streaming drafts (`sendMessageDraft`, 9.3, DM only and fragile on long turns), and **Mini Apps**: a full web page inside Telegram, authenticated for free by validating the signed `initData`, full-screen and pinnable to the home screen.
- **Typing is reduced the same few ways everywhere.** Suggested-prompt chips (Slack: up to 4). Approve a whole **plan** up front instead of each tool (Devin, Muse). A morning **card feed** that expires (ChatGPT Pulse). One-word replies to drafts (Poke). A **board of parallel agents** in an installable PWA (Cursor). Per-action **allow / ask / never** rules set by toggle (OpenAI Dots). An **activity view** of background work (Dots, Muse's audit trail). Voice notes.
- **Generative UI protocols exist but Neo doesn't need them yet.** Google A2UI (declarative JSON from a client-owned component catalog), MCP Apps (tools ship sandboxed `ui://` HTML), AG-UI (an event stream: run, text, tool, state, interrupt). Neo should use a small fixed card catalog now, and name its events so it could speak AG-UI or A2UI later.
- **Push without an app store.** Web Push works on iOS 16.4+ only for home-screen installed web apps, and (unverified) without action buttons, so a tap opens the card. ntfy is self-hostable with up to 3 action buttons, one of which can call Neo's approve endpoint directly. Pushover's emergency priority repeats until acknowledged.

---

## 4. Design A: the channel layer

### 4.1 Shape

```
                 ┌──────────────── engine (no AI) ─────────────────┐
 worker events → │ OperatorHub                                      │
 loops, alerts → │  • one PipelineDeps (reply/askApproval/ask/file) │
 inbox, briefs → │  • NeoEvent log + outbox (ordered, retried)      │ → Channel adapters
                 │  • pending decisions (any channel resolves)      │   telegram · deck(web/PWA)
                 │  • command + action dispatch (one copy)          │   ntfy/web-push · email digest
                 │  • routing/focus per OPERATOR, not per chat      │   (later: slack, discord, signal)
                 └──────────────────────────────────────────────────┘
                         ↑ InboundEvent (text | action | file | voice)
```

`OperatorHub` replaces the per-frontend wiring. It is the only thing that calls
`pipeline.handleMessage`, the only owner of pending approvals, and the only sender. It grows out of the
existing `operator-bus.ts` and the shared half of `web-channel.ts`.

### 4.2 Contracts (proposed TypeScript)

```ts
// What the engine says. Replaces BusLine. Every event has a stable id so a channel can edit in place.
type NeoEvent =
  | { kind: "message";  id: string; project?: string; md: string }
  | { kind: "progress"; id: string; project: string; runId: string;     // one per run, updated in place
      status: "working" | "waiting" | "done" | "failed"; step?: string; steps?: Step[];
      elapsedMs: number; costUsd?: number }
  | { kind: "card";     id: string; project?: string; card: Card }      // see 4.3
  | { kind: "resolved"; id: string; outcome: string; by: ChannelId }    // a card was answered somewhere
  | { kind: "file";     id: string; project?: string; name: string; path: string; caption?: string }
  | { kind: "notice";   id: string; text: string; level: "info" | "warn" | "urgent" }
  | { kind: "echo";     id: string; text: string; from: ChannelId };

// What the operator does. Every channel normalises its input to this.
type InboundEvent =
  | { kind: "text";   channel: ChannelId; text: string; replyTo?: string /* NeoEvent id */ }
  | { kind: "action"; channel: ChannelId; cardId: string; actionId: string; value?: string }
  | { kind: "file";   channel: ChannelId; name: string; bytes: Uint8Array; caption?: string; replyTo?: string }
  | { kind: "voice";  channel: ChannelId; audio: Uint8Array; mime: string; replyTo?: string };

interface Channel {
  id: ChannelId;                       // "telegram" | "deck" | "ntfy" | "email" | ...
  audience: "operator";                // customer channels live in gateway/, never here (firewall)
  caps: {
    buttons: number;                   // max actions per message (0 = text only; WhatsApp 3; Telegram ~100)
    edit: boolean;                     // can update a sent message in place
    richText: "html" | "markdown" | "plain";
    files: boolean; voiceIn: boolean; push: boolean;
    maxLen: number;
  };
  start(hub: HubPort): Promise<void>;  // hub.inbound(ev) is the ONLY way in
  deliver(ev: NeoEvent): Promise<{ ref?: string }>;   // platform message id, for edits and replies
  edit?(ref: string, ev: NeoEvent): Promise<void>;
  stop(): Promise<void>;
}
```

Rules the hub enforces, in code:

1. **Output-only delivery.** `deliver` cannot reach `handleMessage`; only `hub.inbound` can. This is the
   existing bus invariant, kept.
2. **Ordered, retried, logged outbox per channel.** Each channel gets a FIFO with a rate limit taken from
   its caps, retry with `retry_after`, and a final failure logged with the text, never silently dropped.
   This is the fix for Issue 3, moved out of `telegram.ts` so every channel inherits it.
3. **Degrade, don't drop.** If a channel has `buttons: 0`, a card renders as numbered text
   ("Reply 1 to allow, 2 to deny") and the hub maps the typed reply back to the action. The same
   mapping fixes Issue 4: while a decision is open, a typed "yes" / "no" / "1" resolves it.
4. **First answer wins.** A decision can be answered from any channel. The hub resolves the promise
   once, then emits `resolved`, and every channel that showed the card edits it to "Allowed on Deck"
   (or sends a short line if it can't edit). Action ids are single-use and random.
5. **Customer firewall unchanged.** `audience` is the literal `"operator"`; the hub rejects any other
   value at registration. Customer I/O stays in `gateway/` on Gemini. Voice transcription for the
   operator is an AI read, so it goes through `provider-router` as a new `transcribe` route
   (own work), never inline in the engine.

### 4.3 The card catalog (small and fixed)

The engine builds cards deterministically. Workers can request some of them through a Neo MCP tool
(4.4), validated against this catalog; they can't send arbitrary UI.

| Card | Built from | Actions |
|---|---|---|
| **Approval** | governor escalation (`session-runner.ts:251`) | Allow · Deny · Always allow in this project (writes `trust`) · Explain |
| **Question** | worker's `AskUserQuestion` (today denied, `governor.ts:52`) | one button per option, multi-select, "Other…" (text or voice) |
| **Plan** | worker proposes steps before acting | Approve plan · Edit · Cancel; approved plan pre-authorises the listed steps (Devin/Muse pattern) |
| **Progress** | session runner stream | Stop · Open project · Pin; edited in place, not one line per tool call |
| **Result** | run ends | suggested next steps as chips (worker-provided + fixed ones: Run tests, Open PR, Continue, Close) |
| **Brief** | morning brief / loop digest | per item: Open · Snooze · Done; expires next day |
| **Inbox item** | customer inbox (`inbox-actions.ts`) | Draft · Edit · Send (Send still goes through an Approval card) |
| **Picker** | `/list`, `/loop`, `/open` | projects, loops, repos as buttons (already exist as `select` / `inbox` rows) |

```ts
interface Card {
  type: "approval" | "question" | "plan" | "progress" | "result" | "brief" | "inbox" | "picker";
  title: string;
  body?: string;                                   // markdown; each adapter converts
  fields?: { label: string; value: string }[];     // e.g. tool, path, cost
  actions: { id: string; label: string; style?: "primary" | "success" | "danger";
             verb?: "accept" | "edit" | "respond" | "ignore"; needsText?: boolean }[];
  expiresAt?: number;
}
```

Telegram renders this as an HTML message with an inline keyboard (Allow green, Deny red, then disabled
after the tap). Deck renders it as a real card. ntfy renders up to 3 actions as notification buttons.
Email renders links. A text-only channel renders numbered options.

### 4.4 Services the channel layer unlocks in the worker

- **Answer `AskUserQuestion` instead of denying it.** In `canUseTool`, turn the call into a Question
  card, await the answer, and return it to the worker (the Agent SDK accepts answers back through
  `updatedInput`; **verify the exact field against the SDK docs** and record it in `docs/sdk-notes.md`
  before building). Biggest typing reduction for the least code.
- **`mcp__neo__present`**: one in-process tool (allowed by the existing `mcp__neo__` rule,
  `governor.ts:61`) that lets a worker propose a Plan card or attach next-step suggestions to its
  Result card. Validated against the catalog; plain text fallback if invalid.
- **Silence.** A worker or loop that has nothing to report returns nothing, as loops already do
  (`daemon.ts:111`); the hub never sends empty or duplicate lines.

### 4.5 Identity and routing

- An **operator** record owns linked channel identities (Telegram user id, Deck passkey, ntfy topic,
  email). Admin trust-on-first-use stays, but can be claimed from any channel at first run.
- **Deck login without Telegram:** a passkey (WebAuthn) registered from an already-trusted session,
  with the Telegram Login Widget and Mini App `initData` kept as other ways in. Neo can then run with
  no bot token.
- **Focus moves from `chatId` to the operator.** One "current project" follows you across devices;
  each `NeoEvent` carries `project`, and replying to any event (on any channel) routes to its project,
  generalising today's Telegram-only `message-routes.ts`.

### 4.6 Where notifications go

A small config table decides which events go where, so alerts stop being hard-coded to Telegram:

```jsonc
"channels": {
  "enabled": ["telegram", "deck", "ntfy"],
  "route": {
    "card.approval": ["deck", "telegram", "ntfy"],   // everywhere; first answer wins
    "card.question": ["deck", "telegram"],
    "progress":      ["deck"],                        // Telegram gets only start + finish
    "notice.urgent": ["telegram", "ntfy"],            // watchdog, loop failure (daemon.ts:149,190)
    "card.brief":    ["deck", "email"]
  },
  "escalateAfterMs": 600000                           // an unanswered approval re-pings on the next channel
}
```

Candidate channels, cheapest first: **Deck** (upgrade of the existing web console), **ntfy** (one HTTP
POST, action buttons), **email digest** (daily summary; the Cloudflare email worker already exists for
the customer side, but the operator digest should use a separate sender), **Slack/Discord** (adapters
are small once the hub exists), **Signal** (via signal-cli). WhatsApp is the customer channel today; an
operator WhatsApp would need its own number to keep the firewall obvious.

---

## 5. Design B: Neo Deck, the visual channel

**Goal:** most interactions are a tap; typing is for new ideas only; you can see the whole company at a glance.

### 5.1 One page, three ways in

1. **Installable web app (PWA)** served by the existing Bun server (`src/frontends/web.ts`): add a
   manifest and a service worker, and it installs to the home screen on iPhone, Android and desktop.
2. **Telegram Mini App:** the same page opened from a "Deck" button in the bot's menu, authenticated
   by validating `initData` with the bot token. Telegram stays your inbox; Deck opens inside it.
3. **Push:** Web Push (VAPID, self-hosted, no third party) to the installed app; ntfy as the
   alternative with real action buttons on Android. On iPhone a notification tap opens the card.

### 5.2 Screens

- **Today (home).** Top: the **Needs you** queue, every open Approval, Question and Plan card, oldest
  first, each answerable in one tap (swipe right to allow, left to deny). Below: **project tiles**, one
  per live session, showing status colour, current step, elapsed time and cost; tap to open. Then the
  day's **loop timeline** (what ran, what's next) and a **budget gauge** (interactive headroom left,
  from the existing `budget.ts` / `usage.ts`).
- **Project.** A timeline of cards for that project instead of a wall of lines: the plan, one live
  Progress card, files produced, the Result with next-step chips. Quick bar: Continue · Stop · Pin ·
  Trust · Open folder.
- **New work (launcher).** Pick a repo tile (from `listRepos`, `dashboard.ts:37`), then a **recipe** or
  speak. Recipes are saved order templates with fields, e.g. *Fix bug in [repo]: [what's wrong]*,
  *Review open PRs*, *Ship release*, filled by tapping recents. Recipes are a light layer over
  `orders.ts`; the long-term version turns a correction into a proposed recipe (the "skillify" idea in
  `CLAUDE.md`).
- **Board.** The Kanban view of all sessions and dispatched sub-work (Queued · Working · Waiting on you
  · Done), the Cursor pattern, fed by the registry and `dispatch.ts` stall monitor.
- **Inbox.** Customer items as cards (exists on the web console today; moves onto cards).
- **Rules.** The governor policy as toggles per project and tool family: Allow · Ask · Never (the Dots
  "Custom Rules" idea, backed by the existing `trust.ts`). The defaults stay default-escalate; toggles
  only relax what you choose, and nothing customer-tainted can be relaxed.

### 5.3 Ways to answer without typing

- Buttons on every card; chips for suggested next steps; recipes for new work.
- **Mic button** everywhere: the phone's own dictation first (free, on-device); server transcription
  through the `transcribe` provider route next, which also turns Telegram voice notes into orders.
- **Long-press a card** for canned replies ("go ahead", "smaller change", "explain first").
- **Plan approval** instead of per-tool approval for long tasks.
- **Brief deck** in the morning: one card per project and loop, Open · Snooze · Done, gone by tomorrow.

### 5.4 Build choices

- Stay in Bun with no separate frontend project: Bun's bundler builds a small Preact (or vanilla) app
  from `src/frontends/deck/`, served by the existing `Bun.serve`. The existing SSE stream becomes the
  `NeoEvent` stream; replay on reconnect already exists (`web-channel.ts:84`, `subscribe` at `:51`).
- Name events so they map cleanly onto AG-UI (run / text / tool / state / interrupt) in case a
  standard client is wanted later. No A2UI or MCP Apps until workers need to compose UI themselves.
- Security: passkey session, CSRF on every POST, single-use action ids, approvals require a fresh
  session, Deck served behind the existing reverse proxy; nothing in the Mini App path trusts
  `initData` without the HMAC check.

A clickable mockup of these screens: https://claude.ai/artifact/WFPUjpkrkRHx93PVzsYvKm

---

## 6. Build order (each slice TDD, green `bunx tsc --noEmit` + `bun test`)

| Slice | What | Visible result | Notes |
|---|---|---|---|
| 0 | Wait for the Telegram reliability fix to land | Telegram stops dropping lines | Owned by another thread; slice 1 moves its queue into the hub rather than rewriting it |
| 1 | `OperatorHub` + `Channel` interface; port Telegram and web onto it with **no behaviour change**; move daemon alerts (`daemon.ts:149,190`) to `hub.notify` | Nothing new, but one copy of the dispatch code | Biggest refactor; mostly moving code that already has tests |
| 2 | `NeoEvent` + Card catalog; Approval and Picker cards on both channels; first-answer-wins across channels; typed "yes/no/1/2" resolves | Answer an approval anywhere; coloured Allow/Deny | Closes Issue 4 for every channel |
| 3 | Question card: service `AskUserQuestion` | Workers ask with options; you tap | Verify the SDK answer field first |
| 4 | Progress card edited in place | One live card per run instead of a stream | Telegram: edit at ≤1/s |
| 5 | Deck PWA: Today + Project screens, manifest, service worker, Web Push, passkey login | Installable app with a Needs-you queue | Telegram Mini App entry comes free once `initData` auth is added |
| 6 | ntfy channel + `channels.route` config + escalation after N minutes | Approvals reach your lock screen | Small adapter |
| 7 | `mcp__neo__present` (plans, next-step chips), recipes, Board, Rules toggles, voice | Most of the tap-not-type experience | Can be split further |
| 8 | Email digest, then Slack/Discord/Signal adapters as wanted | Telegram is truly one of many | Each a small adapter |

## 7. Decisions for Neo

1. **Name and form of the visual channel:** "Deck" as an installable web app that also opens inside
   Telegram (recommended), versus a native mobile app (adds an app store, but unlocks Live Activities
   and watch approvals, which no PWA can do).
2. **Push provider:** Web Push only (recommended, no third party), add ntfy for lock-screen buttons, or
   Pushover for "keep buzzing until I answer".
3. **Voice transcription route:** on-device dictation only, a local whisper.cpp on the server, or a
   hosted model through the provider router.
4. **Plan approval scope:** should an approved plan pre-authorise every listed step, or only skip
   repeat prompts for the same tool and path?
