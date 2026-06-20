# WhatsApp + Voice customer channels — Design (Phase 3b.2 / 3b.4)

**Status:** in progress — WhatsApp text being implemented; voice outlined
**Date:** 2026-06-20
**Scope:** two new customer channels on the **existing Go gateway** (`/home/neo/gateway`,
module `neo-gateway`): **WhatsApp text** (Gemini 2.5 Flash) and **voice calling** (Gemini 3.1
Flash Live). Both reuse the gateway spine, the Neo `POST /agent/ingress` bridge, and the
`dispatch_to_company` orchestrator tool built for the email slice. Transport: **Twilio** (gopkg
`communication/whatsapp/twilio`, `communication/voice/twilio`, `voice/*`).

## Compliance & the human-in-the-loop question (read first)

The email path is **deliberately human-in-the-loop**: `handleInbound` parks the message in Neo's
inbox ("NO AI, NO auto-reply") and the operator reviews/approves every reply (the `/inbox` loop in
Telegram + web). The Gemini reply orchestrator exists in the gateway but is **dormant** on email.

WhatsApp "chat" and especially **live voice** are autonomous by nature — a real-time phone call
can't be operator-approved turn-by-turn. So these channels run **autonomous Gemini**:

- **Firewall is preserved.** Gemini faces the customer; **Claude never does**. Real work still
  flows only through `dispatch_to_company` → Neo ingress → the company (subscription), which returns
  a *result for the operator*, never a raw customer message to Claude. This is exactly the boundary
  the email spec locked.
- **Divergence from the email invariant is explicit and channel-scoped.** Email stays
  human-in-the-loop, untouched. WhatsApp/voice are new autonomous channels. If the operator wants
  WhatsApp human-in-the-loop instead, it's a one-line swap: point `/inbound/whatsapp` at the same
  `inboxFn` the email path uses (the inbox is already channel-agnostic — `channel:"whatsapp"`).

This decision is surfaced to the operator; the code supports either stance behind the handler.

## Architecture

```
customer ──WhatsApp──▶ Twilio ──webhook(form, X-Twilio-Signature)──▶ POST /inbound/whatsapp
                                                                        │ (sig-validated)
  reply ◀── Twilio WhatsApp Send ◀── gateway ── ai/orchestrator(Gemini 2.5) ──┐
                                       · conversation memory (per sender)       │ dispatch_to_company
                                                                               ▼
                                                                      Neo /agent/ingress → company

customer ──call──▶ Twilio Voice ──Media Streams (WebSocket, μ-law 8k)──▶ /voice/stream
                                                                          │
  audio ◀── Twilio ◀── gateway voice bridge ── voice/llm/gemini (Live, bidi audio) ──┐
            (barge-in, hold-filler)                                                   │ dispatch_to_company
                                                                                      ▼
                                                                             Neo /agent/ingress → company
```

The gateway owns the **customer** conversation; Neo owns the **company's** work. They talk only via
the brief + result over the authenticated ingress.

## Behavioral model — AI front-desk that triages by intent and hands off

WhatsApp/voice are **not** blanket auto-reply. Gemini holds a natural conversation to understand the
customer's **intent**, then routes to an operator handoff (the customer never gets a quote or a
resolution from the AI — only the operator/company does that):

- **Quote / sales** — ask the concise questions needed to scope the project (what they want, scope,
  timeline, budget, contact), then call `handoff_to_operator(intent="quote", summary=…)` and tell
  the customer the team will review and get back with a quote.
- **Support** — capture the issue (what's wrong, order/account, urgency), call
  `handoff_to_operator(intent="support", summary=…)`, and tell the customer **the team will contact
  them shortly**.
- **Simple questions** — answer directly; for a real lookup/action use `dispatch_to_company`.

**Handoff destination = the Neo inbox.** `handoff_to_operator` posts the conversation summary to
Neo's `/inbox` (`channel:"whatsapp"`, `from`=phone, `subject`=intent label, `text`=summary) — the
**same queue the operator already reviews** in Telegram `/inbox` and the web console. "Send me a
summary" = a new inbox item the operator triages and follows up. The AI never promises prices,
deadlines, or actions it hasn't confirmed.

This keeps the customer experience responsive (live chat) while the **business response stays with
the human/company** — consistent with the firewall and the operator-in-the-loop principle.

## WhatsApp text (3b.2) — implemented

**Transport:** Twilio WhatsApp (`gopkg/communication/whatsapp/twilio`). Inbound is Twilio's
form-encoded webhook (`From="whatsapp:+…"`, `Body`, `ProfileName`, `MessageSid`, `WaId`). Outbound
is `Provider.Send(ctx, &provider.SendRequest{RecipientPhone, Body})` — the same `provider` envelope
the email sender uses.

**Auth:** Twilio signs each webhook with `X-Twilio-Signature` = base64(HMAC-SHA1(authToken, URL +
sorted POST params)). The gateway validates it (`twilioSignatureValid`); no shared bearer needed.

**Flow (`handleInboundWhatsApp`):**
1. `ParseForm` → validate `X-Twilio-Signature` against `publicURL + "/inbound/whatsapp"`.
2. Extract sender (`strings.TrimPrefix(From, "whatsapp:")`), `ProfileName`, and `Body`; ignore
   empty/status callbacks.
3. Load recent history for `whatsapp:<sender>` from the conversation cache.
4. `waReplyFn(ctx, sender, name, history, body)` → the Gemini orchestrator with **two tools**:
   `dispatch_to_company` (real work) and `handoff_to_operator` (post a summary to the Neo inbox,
   closing over this sender's phone/name).
5. `waSender.Send(RecipientPhone=sender, Body=reply)` — the AI's customer-facing message.
6. Append both turns to the conversation cache; return 200.

**Operator follow-up:** the summary appears in `/inbox` (subject e.g. "WhatsApp · Quote request").
The operator contacts the customer to close the loop. (Routing an operator inbox *reply* back out
over WhatsApp — vs the current email send path — is a follow-up; for now follow-up is operator-driven.)

**Config (new env):** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
(`whatsapp:+…` or bare `+…`), `PUBLIC_URL` (the gateway's externally-visible base URL, for
signature validation behind Traefik).

**Tests (Go, TDD):** signature validation (valid/invalid/missing); inbound → fake reply → fake
sender asserts recipient/body + persisted turns; bad signature → 401; empty body → 200 no-op; the
handoff dispatcher posts a correctly-shaped summary (channel/from/subject/text) to a fake inbox;
intent → subject label mapping.

## Voice calling (3b.4) — next phase (outlined)

**Transport:** Twilio Programmable Voice → **Media Streams** (a WebSocket of base64 μ-law/8k frames,
bidirectional). gopkg already provides `voice/transport` (Twilio media-stream framing),
`voice/llm/gemini` (`LiveModel = "models/gemini-3.1-flash-live-preview"`, bidi audio),
`voice/pipeline`, `voice/toolexec` (tool calls mid-call → `dispatch_to_company`), and
`voice/holdfiller` (play a tone/filler while the company works so the line isn't dead).

**Flow (sketch):** incoming call → Twilio webhook returns TwiML `<Connect><Stream url=".../voice/stream">`
→ gateway upgrades the WebSocket → bridge Twilio audio ⇄ Gemini Live; on a Gemini tool call, run
`dispatch_to_company` (async — see below) while `holdfiller` keeps the caller company; stream
Gemini's audio back. Barge-in (caller interrupts) is handled by the pipeline.

**Why it needs async ingress:** a live call can't block on a multi-minute company brief. This phase
requires the **async delivery** noted as future work in the email spec (ingress returns a ticket;
the company result arrives via callback/poll), plus a hold-filler. That's the main new
infrastructure voice adds on top of the WhatsApp slice.

## Build order (each its own TDD task group)

1. **WhatsApp text** (this slice): `twilioSignatureValid` + `handleInboundWhatsApp` + config + route
   + main wiring; reuse the orchestrator + conversation cache. Go `go test ./...` green.
2. **WhatsApp deploy:** Twilio number + WhatsApp sender; webhook → `https://neo-api…/inbound/whatsapp`;
   secrets; live round-trip.
3. **Voice spine:** async ingress (ticket + callback) on Neo + gateway; hold-filler wiring.
4. **Voice call:** TwiML connect + `/voice/stream` WebSocket bridge (Twilio ⇄ Gemini Live) +
   `voice/toolexec` → `dispatch_to_company`; barge-in; live test call.

## Out of scope here

Website "contact us" (3b.1). Async-ingress detail and voice get their own task groups before
implementation (build order 3–4).

## What the operator provides

- Twilio account: a number with WhatsApp enabled (sandbox or approved sender) and, for voice, Voice
  + Media Streams; the `AccountSID` / `AuthToken`; the WhatsApp `From`.
- Webhook URLs pointed at the gateway subdomain (`neo-api.tech-gate.online`).
