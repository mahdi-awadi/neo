# Customer Email Gateway — Design (Phase 3b, first slice)

**Status:** approved design → ready for implementation plan
**Date:** 2026-06-20
**Scope:** the *spine* of Neo's customer path + the *email* channel (inbound + outbound), both via
Cloudflare. Other channels (WhatsApp text, voice, web contact) are out of scope here and get their
own specs; they reuse the spine this slice builds.

## Goal

Let customers reach the business by email and get useful answers — without Claude ever touching a
customer. A customer emails `support@tech-gate.online`; **Gemini** (in a separate container) holds
the conversation; when real work is needed it hands a **brief** to the **Neo engine**, which runs it
on the **company / default project** (the operator's Claude subscription) and returns a result;
Gemini composes the reply and sends it back over Cloudflare.

## Why these decisions (locked during brainstorming)

- **Containerized Go gateway on `gopkg`.** Everything Gemini/customer-facing lives in one container
  with its own secrets and no Claude credentials. The compliance firewall ("Claude never touches
  clients directly") becomes a deployment boundary, not just a code rule. `gopkg` already provides
  `ai/llm/geminitext`, `ai/orchestrator` (tool-calling), `ai/conversation`, and the communication
  providers — so this is mostly wiring + a bridge.
- **HTTP bridge (shared secret), not NATS.** The interaction is request/response (Gemini calls a
  tool, waits for the result). Plain authenticated HTTP is simpler than standing up a broker. `bus`
  (NATS) stays available if a later channel needs async.
- **Cloudflare both directions.** Inbound: Email Routing → Email Worker → gateway. Outbound:
  Cloudflare **Email Service REST API** (`POST /accounts/{account_id}/email/sending/send`,
  API-token auth, verified sender domain + DKIM → arbitrary recipients). No third-party sender.
- **Email packaged into `gopkg`.** Build a reusable `email` package (interfaces) + `email/cloudflare`
  implementation, so WhatsApp/voice and any future service reuse it.
- **Synchronous ingress for the MVP.** The gateway's tool call blocks on the company's result with a
  generous timeout. Async/callback delivery is a later improvement (noted under Future work).

## Amendment (2026-06-20): outbound via the Workers `send_email` binding

Outbound email is sent through the Cloudflare **Email Worker** (`env.EMAIL.send(...)` via a
`[[send_email]]` binding), **not** the REST API. The Worker gains a `fetch()` handler the gateway
POSTs replies to (auth = the shared gateway↔Worker secret). Result: **the gateway container holds no
Cloudflare credentials at all** — both inbound and outbound go through the operator-deployed Worker;
the only secrets in the container are the gateway↔Worker shared secret and the Neo ingress secret.
This is a strictly cleaner compliance/security boundary than putting a Cloudflare API token (and the
DNS-edit power that comes with reusing the existing Traefik token) inside the container. The gopkg
`communication/email/cloudflare` REST `Sender` (Tasks 1–2) stays as a reusable library provider; the
gateway uses a small `workerSender` instead. A verified sender domain (DKIM) is still required.

## Architecture

```
customer ──email──▶ Cloudflare Email Routing ──▶ Email Worker (JS)
                                                   │ POST /inbound/email  (Bearer INBOUND_SECRET)
                                                   ▼
  reply ◀── CF Email Service REST ◀──────── Go GATEWAY container ──┐
  (outbound, DKIM domain)                   · ai/orchestrator (Gemini) │ POST /agent/ingress
                                            · ai/conversation (per thread) │ (Bearer INGRESS_SECRET)
                                            · tool: dispatch_to_company ───▶ NEO engine (172.20.0.1:3003)
                                                                            └▶ company / default project
                                                                                └▶ (maybe) a project or desk
```

The gateway owns the **customer** conversation (memory keyed by sender/thread). Neo owns the
**company's** work context (its own SDK session). They communicate only through the brief + result.

## Components & interfaces

### 1. `gopkg/email` — reusable email package (Go)

Core types and interfaces (no Cloudflare specifics here):

```go
package email

type Address struct{ Name, Email string }

type Attachment struct {
    Filename    string
    ContentType string
    Content     []byte // base64-encoded at the transport boundary
}

// Message is an outbound email.
type Message struct {
    From        Address
    To          []Address
    Subject     string
    Text        string            // at least one of Text/HTML required
    HTML        string
    Headers     map[string]string // e.g. In-Reply-To, References (threading)
    Attachments []Attachment
}

// Inbound is a received email, normalized.
type Inbound struct {
    From      Address
    To        []Address
    Subject   string
    Text      string
    HTML      string
    MessageID string // for threading / dedup
    InReplyTo string
}

// Sender sends one outbound Message. Implemented per-provider.
type Sender interface {
    Send(ctx context.Context, msg Message) error
}

// Sentinel errors callers can branch on.
var (
    ErrSenderNotVerified = errors.New("email: sender domain not verified")
    ErrRecipientBlocked  = errors.New("email: recipient suppressed/blocked")
)
```

Subpackage `gopkg/email/cloudflare`:

```go
package cloudflare

// Sender implements email.Sender via Cloudflare Email Service REST API:
//   POST https://api.cloudflare.com/client/v4/accounts/{accountID}/email/sending/send
//   Authorization: Bearer <apiToken>
//   { "from": {...}, "to": [...], "subject": "...", "html": "...", "text": "...",
//     "headers": {...}, "attachments": [{ "filename","content"(base64),"type" }] }
type Sender struct { /* accountID, apiToken, httpClient */ }
func NewSender(accountID, apiToken string, opts ...Option) *Sender
func (s *Sender) Send(ctx context.Context, msg email.Message) error // maps CF error codes → sentinels

// ParseWorkerPayload turns the Email Worker's JSON POST body into an email.Inbound.
func ParseWorkerPayload(body []byte) (email.Inbound, error)
```

The exact CF JSON field names/casing are verified against the API during implementation
(build-then-verify); the request is built behind an injectable `http.RoundTripper` so unit tests
assert the shape without network calls.

### 2. Cloudflare Email Worker (JS, deployed to Cloudflare)

`worker.js` + `wrangler.toml`. On an inbound `ForwardableEmailMessage`: parse MIME (via
`postal-mime`) → extract `from,to,subject,messageId,inReplyTo,text,html` → `POST` JSON to
`GATEWAY_URL` with header `Authorization: Bearer ${INBOUND_WEBHOOK_SECRET}` → return 200.
`wrangler.toml` binds the email route and the two vars. (Authoring + deploy steps documented; the
operator runs the deploy.)

### 3. Go gateway service (containerized)

HTTP server behind Traefik. Endpoints:

- `POST /inbound/email` — auth `Bearer INBOUND_WEBHOOK_SECRET`; body = worker payload. Flow:
  1. `cloudflare.ParseWorkerPayload` → `email.Inbound`.
  2. Load/create the conversation for `Inbound.From.Email` (`ai/conversation`), append the message.
  3. `ai/orchestrator.Process(ctx, llmRegistry, cfg, inboundText)` with one registered tool,
     `dispatch_to_company(brief string)`, whose `ToolDispatcher` calls the Neo ingress (below) and
     returns the result text to Gemini.
  4. Gemini's final text → build a reply `email.Message` (To = sender, In-Reply-To = `MessageID`,
     From = `EMAIL_FROM`) → `cloudflare.Sender.Send`.
  5. Persist the turn to conversation memory.
- `GET /healthz` — liveness.

Configuration is injected (LLM registry, Sender, ingress client, conversation store) so the
orchestration is unit-testable with fakes.

### 4. Neo ingress (TypeScript, in the daemon)

A new authenticated endpoint on the existing server (bound to `172.20.0.1:3003`, reachable from the
container over the docker bridge):

```
POST /agent/ingress
Authorization: Bearer <AGENT_INGRESS_SECRET>
Request:  { "brief": string, "conversationId"?: string }
Response: { "ok": boolean, "result": string }   // 401 on bad/missing secret
```

It runs `brief` on the **company / default project**: a single-shot run rooted at
`/home/neo/agent`, resuming the company's SDK session for context, at `effort:"low"`, **with the
`dispatch` tool available** (so the company can further delegate to a project/desk). Worker output
during the brief streams to the operator's dashboard, tagged, so the operator can observe
customer-driven work. The final result text is returned. Reuses the existing
dispatch/company machinery; no new SDK plumbing. Generous timeout; on timeout, returns
`{ok:false, result:"still working"}` and the gateway sends a holding reply.

**Compliance:** the brief is Gemini-authored work *for the operator* and runs on the company
(subscription). It is never a raw customer message reaching Claude. The provider-router firewall
(`source:"customer"` refused) is unchanged and still guards the order pipeline.

## Configuration & secrets

Gateway container `.env` (no Claude creds): `GEMINI_API_KEY`, `CF_ACCOUNT_ID`, `CF_EMAIL_API_TOKEN`,
`EMAIL_FROM` (`support@tech-gate.online`), `EMAIL_FROM_NAME`, `INBOUND_WEBHOOK_SECRET`,
`NEO_INGRESS_URL` (`http://172.20.0.1:3003/agent/ingress`), `NEO_INGRESS_SECRET`, `LISTEN_ADDR`.

Neo `.env`: `AGENT_INGRESS_SECRET` (= the gateway's `NEO_INGRESS_SECRET`).

Email Worker vars: `GATEWAY_URL` (e.g. `https://neo-api.tech-gate.online/inbound/email`),
`INBOUND_WEBHOOK_SECRET`.

All secrets `chmod 600`, gitignored, never logged.

## Deployment

- **Gateway**: a Docker image (multi-stage Go build) run via compose; routed by Traefik on a new
  subdomain (e.g. `neo-api.tech-gate.online`) so the Cloudflare Email Worker can POST inbound. Reaches Neo
  at `172.20.0.1:3003` over the docker bridge.
- **Neo ingress**: added to the existing Bun server. Protected by `AGENT_INGRESS_SECRET`; a Traefik
  rule may additionally block `/agent/ingress` from the public router (defense in depth) — the secret
  is the primary control.
- **Cloudflare** (operator-run): Email Routing on the domain (catch `support@`), a verified sender
  domain + DKIM for Email Service, an API token scoped to email send, and `wrangler deploy` of the
  worker.

## Error handling

- Bad/missing ingress secret → 401, nothing runs.
- Company brief errors/timeouts → gateway sends a graceful holding/apology reply; the failure is
  logged with the conversation id.
- `Send` returns `ErrSenderNotVerified`/`ErrRecipientBlocked` → logged; surfaced to the operator (the
  domain/DKIM isn't set up) rather than silently dropped.
- Inbound parse failures → 422 to the worker (so it can retry/log), nothing dispatched.
- Worker can't reach the gateway → Cloudflare retries; no mail is lost (Email Routing queues).

## Testing strategy

- **`gopkg/email`** (Go): `cloudflare.Sender.Send` builds the correct REST request (asserted via a
  fake `RoundTripper`); CF error codes map to sentinels; `ParseWorkerPayload` parses sample payloads
  (plain, HTML, threaded, with attachments) and rejects malformed ones.
- **Neo ingress** (Bun): missing/bad secret → 401; valid secret runs a stubbed company and returns
  the result; reuses the existing fake-start harness; no real SDK calls.
- **Gateway** (Go): inbound → orchestrator(fake Gemini that calls the tool) → ingress(fake) → reply
  via Sender(fake), asserting the dispatched brief and the sent reply; conversation memory persists
  across two emails in a thread.
- **End-to-end** (manual, like prior live verifications): real email to `support@` → observe the
  company run in the dashboard → receive the reply.

## Build order (each its own TDD task group)

1. `gopkg/email` package — types, `Sender` interface, `email/cloudflare` (Send + ParseWorkerPayload).
2. Neo `POST /agent/ingress` + `runCompanyBrief` — auth, run on the company, return result.
3. Go gateway service — inbound handler → orchestrator + `dispatch_to_company` tool → reply.
4. Cloudflare Email Worker + `wrangler.toml`; deploy; live inbound round-trip into the gateway.
5. Dockerfile + compose + Traefik route + secrets; live end-to-end email round-trip.

## Out of scope (separate specs)

Website "contact us" (3b.1), WhatsApp text (3b.2), voice / Gemini Flash Live (3b.4). Each reuses the
gateway, the Neo ingress, and the orchestrator built in this slice.

## Future work

- **Async delivery**: ingress returns a ticket; Neo calls the gateway back (or the gateway polls)
  when the company finishes, so slow work doesn't hold an HTTP connection. Needed before voice and
  for long-running customer tasks.
- **Outbound-initiated email** (not just replies) once a sender domain is verified.
- **Conversation persistence** beyond process memory (a store) so threads survive restarts.

## What the operator provides

- Cloudflare account + domain with Email Routing enabled; confirm `support@tech-gate.online`.
- A verified sender domain with DKIM for Email Service; an API token scoped to email send.
- The gateway subdomain (default `neo-api.tech-gate.online`).
