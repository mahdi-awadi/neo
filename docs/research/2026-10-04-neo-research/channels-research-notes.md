# Channels & Operator-UI Research for Neo (2026-10-04)

Purpose: inputs for (1) a channel-adapter abstraction where Telegram is one channel among many,
and (2) a new "low typing, graphic, clickable" operator channel.
Confidence tags: [V] = verified against the cited page today; [S] = from secondary source / summary;
[U] = unverified / my inference.

---

## A. How agent frameworks abstract channels

### A1. OpenClaw (ex-Clawdbot/Moltbot): Gateway + channel plugins
- Gateway is a single Node process (default bind `127.0.0.1:18789`) that connects messaging platforms
  and dispatches each routed message to the agent runtime. [S] https://ppaolo.substack.com/p/openclaw-system-architecture-overview
- **Session keys encode trust**: your own DMs map to `main`; others become `dm:<channel>:<id>` or
  `group:<channel>:<id>`, each with its own permissions/sandboxing. [S] same source
- **DM pairing**: `dmPolicy="pairing"` default; unknown sender gets a pairing code, owner runs
  `openclaw pairing approve <channel> <code>`. [S] same source
- `ChannelPlugin` shape (docs mirror): `id`, `meta` (label, docsPath, blurb, order), `capabilities`
  (`supportsDm`, `supportsGroup`, `supportsPolling`), `config`, `gateway` (inbound), `outbound`
  (`send({account,to,payload}) -> {ok, error?}`), `status`; optional `auth` (e.g. `loginWithQr`),
  `pairing`, `groups`, `mentions`, `directory`. [S] https://mintlify.wiki/openclaw/openclaw/plugins/channels
- Official docs list plugin-owned concerns: config, security, pairing, session grammar, outbound,
  threading; core owns the shared `message` tool, session keys, generic threading, model-picker
  actions. Adapter areas: Message adapter (normalize), Durable Ingress, Status & Media, Sessions &
  Bindings, **Approvals (render buttons + action callbacks)**, Setup/Config, Mention policy.
  Inbound context built with `buildChannelInboundEventContext`. [V] https://docs.openclaw.ai/plugins/sdk-channel-plugins
- **Durable ingress/outbound**: "Core owns queueing, durability, the durable ingress monitor and
  drain"; plugin owns native send/edit/delete, target normalization, platform threading.
  `createChannelIngressMonitor`, callbacks `inspect(raw) -> {eventId, laneKey}`, `deliver(raw,
  lifecycle, claim)`; states `completed | deferred | failed-retryable`. [V] https://docs.openclaw.ai/plugins/sdk-channel-outbound
- Per-channel formatting: adapter converts markdown to platform markup and chunks to size limits. [S]
- Outbound slot names `sendText`/`sendMedia`/`chunker`/`textChunkLimit` and capability flags
  (`reactions`, `threads`, `polls`, `blockStreaming`) were reported by a summarizer but I could not
  confirm them on a primary page. [U] https://docs.openclaw.ai/plugins/architecture
- Lesson from their issue tracker: Telegram exec-approval buttons were a long-running pain — many
  issues asking for inline buttons, callbacks "silently dropped when execApprovals not set", and
  approval UI going to the wrong forum topic. Approvals must be a first-class, routed, tested part of
  the adapter, not an add-on. [V titles] https://github.com/openclaw/openclaw/issues/45670 ,
  https://github.com/openclaw/openclaw/issues/54505 , https://github.com/openclaw/openclaw/issues/16111

### A2. Hermes Agent (Nous Research): messaging gateway + platform adapters
- Flow: "User <-> Platform <-> Platform Adapter <-> Gateway Runner <-> AIAgent". Adapters extend
  `BasePlatformAdapter` (`gateway/platforms/base.py`). [V] https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters
- Required: `connect() -> bool`, `disconnect()`, `send() -> SendResult{success, message_id}`.
  Optional: `send_typing()`, `get_chat_info()`, `_keep_typing()` (mid-flight UX for slow turns /
  expiring reply tokens), `interrupt_session_activity()` (for `/stop`). Inbound normalized into
  `MessageEvent` (text, type, chat/user ids, message id) then `self.handle_message(event)`. [V]
- 25+ platforms incl. Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Matrix, Teams,
  Home Assistant, **ntfy**, IRC, plus an OpenAI-compatible API server. [V] https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
- **Durable delivery ledger** around every send, at-least-once; ambiguous redeliveries prefixed
  "Recovered reply". **Silence tokens** (`[SILENT]`, `NO_REPLY`) suppress delivery but stay in
  transcript. **Home channel** receives cron results/alerts. Approvals via `/approve` `/deny` text
  commands. Voice transcription on Telegram/Discord/Slack. Allowlist or DM pairing by default. [V]
- Degradation is documented as a per-platform feature matrix (e.g. SMS: no images, files, threads,
  reactions, typing, streaming; Teams: no voice replies). [V]

### A3. Vercel Chat SDK (`npm i chat`)
- "Write your bot logic once, deploy everywhere." Core: `Chat`, `Thread`, `Message`; handlers
  `onNewMention`, `onSubscribedMessage`, `onAction`, slash commands, modals, reactions. [V] https://github.com/vercel/chat
- Adapters: Vercel-maintained Slack, Teams, Google Chat, Discord, GitHub, Linear, Telegram, WhatsApp;
  vendor Beeper (Matrix), iMessage, Resend (email), Liveblocks; community Webex, Mattermost, etc. [V] https://chat-sdk.dev/adapters
- **JSX cards that degrade per platform**: `Card`, `CardText`, `Section`, `Fields/Field`,
  `Button{id, style: primary|danger, value}`, `Actions`, `LinkButton`, `Select`, `RadioSelect`,
  `Table`, `Chart`, `Image`, `Divider`. Rendered natively (Block Kit / Adaptive Cards / Google Chat
  cards). Explicit fallbacks: `Table` -> native on Slack/Teams/GitHub/Linear, GFM in Discord,
  "padded ASCII text elsewhere"; `Chart` -> native on Slack, else "data rendered as a text table". [V] https://chat-sdk.dev/docs/cards
- Streaming: "platform-native streaming where available (e.g. Slack and Teams) and falls back to
  post-then-edit on other platforms." State adapters: memory/Redis/Postgres, per-thread state 30-day
  TTL (`thread.state`, `thread.setState`). Concurrency policies: burst/queue/debounce/drop/sequential. [V] https://vercel.com/kb/guide/the-complete-guide-to-chat-sdk
- **Durable approvals**: workflow calls `createWebhook()`, puts its URL as the button `callbackUrl`,
  then `await webhook` suspends (survives restarts) until click; branch on `actionId`. "No separate
  approvals table, no onAction callback that has to look up which workflow is waiting." [V] https://vercel.com/kb/guide/human-in-the-loop-with-chat-sdk-and-workflow-sdk

### A4. Rasa channel connectors (classic, still the clearest degradation model)
- `InputChannel` (`name()`, `blueprint()` webhook routes) / `OutputChannel`. Only
  `send_text_message()` is required; `send_image_url`, `send_text_with_buttons`,
  `send_quick_replies`, `send_elements`, `send_attachment`, `send_custom_json` have **default
  implementations that degrade to text** ("Default implementation will just post the buttons as a
  string"; quick replies -> buttons). [V] https://rasa.com/docs/reference/channels/custom-connectors/

### A5. Botpress integrations
- 11 built-in message types every channel integration must accept: text, image, audio, video, file,
  location, carousel, card (image + action buttons), dropdown, choice, bloc (composite). Integrations
  may add properties but not remove them ("payload must be compatible with `{ text: string }`").
  No documented degradation rules. [V] https://botpress.com/docs/api-reference/runtime-api/concepts

### A6. Microsoft Bot Framework / Adaptive Cards Universal Actions
- `Action.Execute{verb, data, fallback}` unifies Teams `Action.Submit` + Outlook `Action.Http`. Bot
  receives an `invoke` activity named `adaptiveCard/action`; replies 200 with a **new card**
  (`application/vnd.microsoft.card.adaptive`) that replaces the old one in place. `refresh` with
  `userIds` (max 60) auto-updates the card per viewer. `fallback` per element/action for older
  clients; schema 1.4+. [V] https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/universal-action-model
- Takeaway: "click -> server returns the updated card" is the cleanest approval UX (card visibly
  flips to "Approved by Neo 14:02").

### A7. LangGraph Agent Inbox
- `HumanInterrupt{ action_request{action, args}, config{allow_ignore, allow_respond, allow_edit,
  allow_accept}, description(markdown) }`; `HumanResponse.type` in `accept | edit | response |
  ignore`. Inbox UI lists interrupts per thread with these four verbs. Repo active. [V] https://github.com/langchain-ai/agent-inbox
- Takeaway: Neo's approval card model should be exactly these four verbs, with per-request flags
  for which verbs are allowed (governor decides).

### A8. Letta channels
- Custom channel adapter: `start()`, `stop()`, `isRunning()`, `sendMessage(message)`,
  `sendDirectReply(chatId, text)`; inbound envelope = channel id, account id, chat id, sender id +
  display name, text, message id, timestamp; runtime applies DM policy, routing table, pairing.
  `messageActions.describeMessageTool()` / `handleAction()` expose channel actions as an agent tool.
  First-party: Slack, Telegram, Discord, WhatsApp, Signal. [V] https://docs.letta.com/self-hosting/channels/custom

### A9. Common adapter shape (synthesis) [U - my design inference]
- Inbound: `{channel, accountId, chatId, threadId?, senderId, text, attachments[], replyTo?,
  action?{id, value}, ts, rawRef}` -> engine.
- Outbound: semantic intents, not platform calls: `post(text|card)`, `update(ref, card)`,
  `stream(ref, chunk)`, `ask(approval)`, `notify(level)`, `file(blob)`.
- Capabilities declared by adapter: buttons(max, styles), edit, streamingNative, threads, files,
  voiceIn, cardsNative, maxTextLen. Engine renders one Card model; adapter degrades (Rasa/Chat SDK
  pattern: buttons -> numbered text reply "1/2/3"; table -> ASCII; chart -> table/image).
- Durable outbound ledger + idempotent action ids (Hermes, OpenClaw) - an approval click must
  resolve exactly one pending governor decision even if delivered twice or on two channels.

---

## B. Agent-driven / generative UI protocols

### B1. Google A2UI
- v0.9 stable; v1.0 is release candidate (spec created 2025-11-20, updated 2026-06-08). [V] https://a2ui.org/specification/v1.0-a2ui/
- Messages: `createSurface`, `updateComponents` (flat adjacency list, children by id, mandatory
  `root`), `updateDataModel` (JSON Pointer paths), `deleteSurface`; v1.0 adds
  `callAgentFunction`/`callRendererFunction` + responses. Inputs two-way bind locally; agent only
  sees state when an action fires (`event`), optionally with the full data model (`sendDataModel`). [V]
- Declarative JSON against a **component catalog** the client owns ("the agent should adapt to your
  frontend"); basic catalog: Text, Button, Card, Row, Column, List, TextField, CheckBox,
  DateTimeInput... Renderers: React, Flutter, Lit, Angular. Security rationale: agent never ships
  executable code. [S] https://www.copilotkit.ai/blog/a2ui-whats-new-in-google-generative-ui-spec
- Transports: AG-UI, A2A, SSE+JSON-RPC, WebSockets. [V]

### B2. MCP Apps (SEP-1865, from MCP-UI + OpenAI Apps SDK)
- Status **Final** (Extensions Track, created 2025-11-21). UI = predeclared `ui://` resources,
  mime `text/html;profile=mcp-app`, linked from tools via metadata; rendered in **sandboxed iframes**;
  UI<->host talk via standard MCP JSON-RPC over postMessage; host may require consent for
  UI-initiated tool calls. Spec dated 2026-01-26 in ext-apps repo. [V] https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp
- Relevance: Neo workers already speak MCP; a Neo console could be an MCP Apps host, letting a
  worker's MCP tools ship their own small UIs. [U]

### B3. OpenAI Apps SDK
- MCP server + widget; tool `_meta["openai/outputTemplate"] = "ui://widget/x.html"`, mime
  `text/html+skybridge`; widget gets `window.openai.toolOutput` (from `structuredContent`),
  `callTool`, `sendFollowUpMessage`, `setWidgetState`. [S] https://www.mcpjam.com/blog/apps-sdk-dive
  (Converging onto MCP Apps per SEP text.)

### B4. AG-UI (CopilotKit)
- Event stream agent->UI: lifecycle (`RUN_STARTED`...), `TEXT_MESSAGE_*`, `TOOL_CALL_*`,
  `STATE_SNAPSHOT`/`STATE_DELTA`, interrupts (pause/approve/edit/retry), custom events; "frontend
  tools" let the agent call typed UI actions and get results. Over HTTP/SSE/WebSocket. Positions
  itself as the transport; A2UI is the widget spec on top. [V] https://docs.ag-ui.com/
- Relevance: Neo's web console already uses SSE; AG-UI's event taxonomy is a ready-made vocabulary
  for the console stream (run/tool/state/interrupt). [U]

### B5. Vercel AI SDK 6
- Tool `needsApproval: true | (input)=>bool`; UI sees part state `approval-requested` and calls
  `addToolApprovalResponse({id, approved})`. `ToolLoopAgent`; `useChat` renders typed
  `message.parts` per tool. [V] https://vercel.com/blog/ai-sdk-6

### B6. Slack (Block Kit + agent surfaces)
- Oct 2025: `chat.startStream` / `appendStream` / `stopStream`; blocks `feedback_buttons`,
  `icon_button`, `context_actions`. [V] https://docs.slack.dev/changelog/2025/10/7/chat-streaming/
- Agent surfaces: split-view container, `assistant.threads.setSuggestedPrompts` (up to 4 preset
  prompts), status/loading with stop button, **task blocks** (in_progress/completed/error) and **plan
  blocks** (pending/in_progress/completed/error). [V] https://docs.slack.dev/ai/agent-entry-and-interaction/

### B7. Adaptive Cards -> see A6 (in-place card replacement, `fallback`, `refresh`).

### B8. Telegram (most relevant: Neo's current channel)
- Changelog (all [V] https://core.telegram.org/bots/api-changelog):
  - 9.1 (2025-07-03): Checklists `sendChecklist`/`editMessageChecklist` (business accounts).
  - 9.2 (2025-08-15): checklist task replies; Suggested Posts (approve/decline).
  - **9.3 (2025-12-31): `sendMessageDraft` - stream partial messages**; topics in private chats.
  - **9.4 (2026-02-09): button `style` + custom-emoji icons**; topics in private chats enabled.
  - 9.5 (2026-03-01): `date_time` entity; custom emoji in keyboard buttons.
  - 10.0 (2026-05-08): Guest Mode, live photos. 10.1 (2026-06-11): **Rich Messages** (structured
    formatting incl. math). 10.2 (2026-07-14): **Ephemeral messages** (visible to one user in group),
    rich block classes. 10.3 (2026-08-24): expandable block quotes, documents in messages,
    **disabled buttons**, ephemeral can replace original.
- `InlineKeyboardButton.style`: `"danger"` red, `"success"` green, `"primary"` blue; also
  `copy_text`, `web_app` (private chats only), `callback_data` 1-64 bytes, `disabled`. [V] https://gramio.dev/telegram/types/inlinekeyboardbutton
  -> Allow = success, Deny = danger, and disable after click: native "card flips" in Telegram.
- Rich messages methods `sendRichMessage` / `sendRichMessageDraft`; ephemeral
  `editEphemeralMessage*`, `deleteEphemeralMessage`. [S - summarizer read of api page] https://core.telegram.org/bots/api
- `sendMessageDraft` available to all bots from 2026-03-01 [S] https://github.com/openclaw/openclaw/issues/32180 ;
  field reports: **DM-only**, drafts are a ~30 s preview that vanishes if not refreshed (bad during
  long tool calls), ghost-draft race at finalization. [S] https://github.com/fitz123/minime-bot/issues/149
  -> keep edit-message fallback (~1 edit/s throttle) for long turns.
- **Mini Apps** (full web UI inside Telegram): launch from inline button, menu button, Main Mini App,
  direct link `t.me/bot/app?startapp=`; `MainButton`/`SecondaryButton`, `HapticFeedback`,
  `BiometricManager`, `CloudStorage`/`DeviceStorage`/`SecureStorage`, `requestFullscreen()`,
  `addToHomeScreen()`, `downloadFile()`. `initData` signed (HMAC-SHA256 from bot token; Ed25519 for
  third parties) - validate server-side = free auth. [V] https://core.telegram.org/bots/webapps
  Mini Apps 2.0 (2024-11-17) added fullscreen + home-screen shortcuts. [V] https://telegram.org/blog/fullscreen-miniapps-and-more
  -> **Cheapest path to a graphic channel: the same web console page served as a Telegram Mini App,
  authed by initData, opened from a "Dashboard" button.** [U design inference]

### B9. WhatsApp Cloud API interactive
- Reply buttons: **max 3**, label <= 20 chars, id <= 256 chars, body <= 1024, footer <= 60; header
  text/image/video/document; webhook returns `button_reply{id,title}`. [V] https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
- List messages (up to 10 rows) and WhatsApp Flows (multi-screen forms) exist. [S] https://developer.vonage.com/en/messages/guides/whatsapp-interactive-messages
- Note for Neo: WhatsApp is on the customer/Gemini side of the firewall; an operator WhatsApp
  channel would need a separate number/identity to keep roles clean. [U]

### B10. Discord Components V2
- Flag `IS_COMPONENTS_V2 = 1<<15 (32768)`; Container(17), Section(9), TextDisplay(10),
  Thumbnail(11), MediaGallery(12), File(13), Separator(14), Label(18) + buttons/selects, plus newer
  Radio/Checkbox groups and File Upload; max 40 components/message; `content`/`embeds` disallowed;
  interactions return `custom_id`, respond with `UPDATE_MESSAGE`. [V] https://docs.discord.com/developers/components/reference

---

## C. Consumer-agent interaction UX (2025-2026)

- **OpenAI Dots** (launched 2026-09-29, GPT-6 Astra): persistent "always-on" agents with own cloud
  computer/browser; you set an *objective + standards*, not single prompts. Governance: read-only
  proactive research needs no approval; **Custom Rules** per action = allow / require approval /
  prohibit; auto-review of consequential actions; **Activity View** to inspect background work and
  intervene. Reached via ChatGPT/Codex; Slack/Teams/text coming. ChatGPT **Space** = shared pages
  where you tag Dots, schedule updates, or event-trigger automations. [S] https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams ,
  https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/
  -> Custom Rules (allow/ask/deny per action) == Neo governor policy, but user-editable by tap. [U]
- **Meta Muse** (2026-09-08): app + WhatsApp + web; "keeps working after people close the app, and
  comes back when something changes or when it needs approval"; asks before email/purchase; shows "a
  complete audit trail of everything it has done and plans to do". [V] https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
  -> "plans to do" list = pre-approval of a whole plan, not per-tool clicks. [U]
- **xAI Grok Bot** (beta 2026-08-11): fleet of always-on cloud agents that sign into your tools. UX
  details not verified. [U] https://www.tryfriday.ai/blog/grok-bot-launch
- **ChatGPT Pulse** (2025-09-25): overnight async research -> morning feed of **visual cards** you
  scan or expand; thumbs up/down to curate; items expire daily unless saved. [V] https://www.tomsguide.com/ai/chatgpt-pulse-is-here-now-ai-starts-the-chat-and-curates-your-feed
  -> Neo morning brief = card deck (one card per project/loop), with 1-tap actions, auto-expiring. [U]
- **Poke** (Interaction Co.): lives in iMessage/SMS/WhatsApp; proactive alerts, email triage, drafts
  approved with one-word replies ("yes, and say something nice"), automations created by text;
  voice dictation. [S] https://www.productpep.com/blog/2025/11/16/its-finally-cool-to-poke
- **Claude inline visuals** (Mar 2026): ephemeral interactive HTML/SVG charts/diagrams generated
  inline in chat, distinct from persistent artifacts; ~up to 30 s each. [S] https://thenewstack.io/anthropics-claude-interactive-visualizations/
- **Cursor agents web/mobile** (2025-06-30): installable **PWA**, **Kanban of parallel agents**,
  review diffs and open PRs from phone, Slack `@Cursor` trigger + completion notifications. [V] https://cursor.com/blog/agent-web
- **Devin 2.0** (2025-04-03): parallel Devins each with cloud IDE; **Interactive Planning** - plan
  shown in seconds for human edit *before* autonomous execution. [V] https://cognition.com/blog/devin-2?_bhlid=dc898c045f48306e86f85c87a179dcc0aacd7ff4
- **Linear agents**: agent sessions with immutable activities `thought | action | elicitation |
  response | error`; must acknowledge within **10 s** or shown unresponsive; stale after 30 min idle. [V] https://linear.app/developers/agent-best-practices
  -> good minimal event taxonomy for Neo's session timeline + "elicitation" = typed question card.
- **Slack**: suggested prompts (4 chips), plan/task blocks, feedback buttons (see B6).
- What reduces typing (synthesis) [U]: suggested-prompt chips; approve/deny/edit/respond verbs;
  plan-level approval (Devin/Muse) instead of per-tool; morning card feed with expiry (Pulse);
  one-word replies to drafts (Poke); Kanban board of sessions (Cursor); per-action rules editable by
  toggle (Dots); voice notes; push with action buttons so approval happens from the lock screen.
- Apple Watch / Live Activities: require a native iOS app (ActivityKit); not reachable from a PWA,
  ntfy or Telegram. [U - from general knowledge, not re-verified]

---

## D. Cheap push + voice channels

### D1. Web Push to a self-hosted PWA
- iOS/iPadOS 16.4+ supports Web Push **only for Home-Screen-installed web apps**; permission prompt
  must come from a user gesture; in a Safari tab, no push. [V] https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications
- Safari 18.4: **Declarative Web Push** on iOS/iPadOS 18.4 for Home-Screen apps - notification shown
  without a Service Worker. [V] https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- Notification action buttons on iOS Web Push: believed unsupported (tap opens the PWA to a deep
  link instead). [U] Design for "tap -> approval card", not lock-screen buttons, on iOS.
- Self-host: VAPID keys + `web-push` npm lib; no third-party service needed. [U general knowledge]

### D2. ntfy (self-hostable, open source)
- HTTP PUT/POST to a topic; priority 1-5; tags->emoji; markdown; `Click` URL; attachments (15 MB
  local, 3 h expiry); **up to 3 action buttons**: `view`, `http` (fires a REST call - e.g. Neo's
  approve endpoint - straight from the notification), `broadcast` (Android), `copy`; scheduled
  delivery; token auth. [V] https://docs.ntfy.sh/publish/
- Hermes already ships ntfy as a gateway platform. [V] (A2)
- iOS: self-hosted servers need upstream forwarding via ntfy.sh for instant iOS delivery. [U - not
  re-verified today]

### D3. Pushover
- Priority -2..2; **2 = emergency**: repeats every `retry` (>=30 s) until acknowledged, up to
  `expire` (<=10,800 s), receipt/ack API; `url`+`url_title` link; HTML; 1,024 chars; image <=5 MB;
  `ttl`; 10,000 msgs/month free per app. [V] https://pushover.net/api
  -> good for "approval blocking a running session" escalation. (One-time app purchase per platform. [U])

### D4. Voice input
- Telegram voice notes arrive as OGG/Opus; Gemini accepts `audio/ogg`/`audio/opus` natively, 32
  tokens/s (1,920 tokens/min), up to 9.5 h, 20 MB inline. [V] https://ai.google.dev/gemini-api/docs/audio
- Prices (Apr 2026 secondary): OpenAI Whisper $0.006/min; Groq Whisper (turbo) ~$0.04/hour; Google
  STT Chirp ~$0.006/min. [S] https://tokenmix.ai/blog/whisper-api-pricing
- Local option: whisper.cpp / faster-whisper on the server (zero marginal cost). [U]
- Neo constraint: engine has no AI; transcription is an AI read like Gemini's customer reads - put
  it behind a provider-router "transcribe" route (operator source -> own-work provider), not inline
  in the engine. [U design inference]

---

## Implications for Neo (design notes) [U]
1. One `Card` model (title, body md, fields, actions[{id, label, style, verb}]), rendered by each
   adapter; degrade buttons -> numbered replies, tables -> ASCII, charts -> image/table.
2. Approval = `{requestId, verbs: accept|edit|respond|ignore, allowed flags}` from the governor; any
   channel can resolve it; first resolution wins, others get the card updated to "resolved by X".
3. Durable outbound ledger + idempotent action ids; silence token for "nothing to report".
4. Graphic channel = existing web console as PWA (Web Push) **and** as Telegram Mini App (initData
   auth) - one codebase, two entry points; Kanban of sessions, approval inbox, morning card deck,
   suggested-prompt chips, voice button.
5. Push tiering: Telegram message (normal) -> ntfy/Web Push (needs action) -> Pushover emergency
   (approval blocking work > N min).
6. Event taxonomy for the console/SSE: borrow AG-UI (run/text/tool/state/interrupt) or Linear
   (thought/action/elicitation/response/error); A2UI catalog if agents should compose UI.
