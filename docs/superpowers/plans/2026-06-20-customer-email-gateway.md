# Customer Email Gateway — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let customers email `support@tech-gate.online` and get answered by Gemini (in a container), which hands real work to the Neo company over an HTTP bridge — Claude never touches the customer.

**Architecture:** A containerized **Go gateway** (built on `gopkg`) owns the customer conversation on Gemini; inbound mail arrives via a **Cloudflare Email Worker**, outbound replies go via the **Cloudflare Email Service REST API**. When work is needed, the gateway calls an authenticated **Neo HTTP ingress** that runs a brief on the **company/default project** (the operator's subscription) and returns the result.

**Tech Stack:** Go 1.23 modules in the `/home/gopkg` go.work workspace (`communication/provider`, `ai/orchestrator`, `ai/llm` + `ai/llm/geminitext`, `ai/conversation`); Bun + TypeScript for the Neo daemon; a Cloudflare Email Worker (JS, `postal-mime`, `wrangler`); Docker + Traefik.

## Global Constraints

- **Compliance firewall (hard):** the gateway container holds Gemini/Cloudflare secrets and **no Claude credentials**; Neo runs the company on the subscription and does **no** customer I/O. `provider-router.ts` still refuses `source:"customer"` — unchanged.
- **TDD:** failing test → watch it fail → minimal code → green → commit. One task = one commit (Go: `go test ./...`; Neo: `bun test` + `bunx tsc --noEmit` green before committing).
- **gopkg pattern:** new providers implement `communication/provider.EmailProvider` and mirror `communication/email/sendgrid` exactly (Config/New/Code/Send/SendWithAttachments/GetStatus/ValidateConfig/Enabled + `var _ provider.EmailProvider = (*Provider)(nil)`).
- **Subdomain:** the gateway is served at `neo-api.tech-gate.online` behind Traefik. Everything customer-facing runs **in a container**.
- **Secrets:** `.env` files `chmod 600`, gitignored, never logged. Neo's customer firewall and budget guard are untouched.
- **Module paths:** `github.com/mahdi-awadi/gopkg/<path>`. Add new modules to `/home/gopkg/go.work` with `go work use <dir>`.

---

## File Structure

- `/home/gopkg/communication/email/cloudflare/cloudflare.go` — outbound `provider.EmailProvider` via CF Email Service REST. **(Task 1)**
- `/home/gopkg/communication/email/cloudflare/inbound.go` — `Inbound` type + `ParseInbound` for the Email Worker payload. **(Task 2)**
- `/home/gopkg/communication/email/cloudflare/{cloudflare,inbound}_test.go` — Go tests. **(Tasks 1–2)**
- `/home/neo/src/engine/ingress.ts` — `runCompanyBrief()` (runs a brief on the company, returns the result). **(Task 3)**
- `/home/neo/src/frontends/web.ts` — add `POST /agent/ingress` (Bearer-secret) + `channel.notify`. **(Task 3)**
- `/home/neo/src/engine/web-channel.ts` — add `notify(text, project)`. **(Task 3)**
- `/home/neo/src/daemon.ts` / `src/config.ts` — thread `AGENT_INGRESS_SECRET`. **(Task 3)**
- `/home/neo/gateway/` — the gateway module: `main.go`, `config.go`, `server.go`, `inbound.go`, `orchestrate.go`, `memstore.go`, `ingress.go`, `*_test.go`, `go.mod`, `go.work`, `Dockerfile`, `.env.example`. **(Tasks 4, 6)**
- `/home/neo/gateway/worker/` — `worker.js`, `wrangler.toml`, `package.json`. **(Task 5)**
- `/home/traefik/dynamic/neo-api.yml` — Traefik route. **(Task 6)**

---

## Task 1: gopkg `communication/email/cloudflare` — outbound provider

**Files:**
- Create: `/home/gopkg/communication/email/cloudflare/cloudflare.go`
- Create: `/home/gopkg/communication/email/cloudflare/go.mod`
- Test: `/home/gopkg/communication/email/cloudflare/cloudflare_test.go`
- Modify: `/home/gopkg/go.work` (add `./communication/email/cloudflare`)

**Interfaces:**
- Consumes: `github.com/mahdi-awadi/gopkg/communication/provider` — `provider.EmailProvider`, `provider.SendRequest{RecipientEmail,Subject,Body,HTMLBody,Options}`, `provider.SendResponse{Success,ProviderCode,ProviderMessageID,Error,RawResponse}`, `provider.Attachment{Filename,ContentType,Content}`, `provider.DeliveryStatus`, `provider.Channel`/`ChannelEmail`, `provider.NewProviderError`.
- Produces: `cloudflare.Config{AccountID,APIToken,FromEmail,FromName}`, `cloudflare.New(cfg, logger) *Provider`, `cloudflare.WithHTTPClient(*http.Client) Option`, `cloudflare.ProviderCode = "cloudflare"`. `Provider` implements `provider.EmailProvider`. `Send` POSTs to `https://api.cloudflare.com/client/v4/accounts/{AccountID}/email/sending/send`.

- [ ] **Step 1: Scaffold the module**

```bash
mkdir -p /home/gopkg/communication/email/cloudflare
cd /home/gopkg/communication/email/cloudflare
go mod init github.com/mahdi-awadi/gopkg/communication/email/cloudflare
go work use .                       # run from /home/gopkg if `go work use` errors; then: (cd /home/gopkg && go work use ./communication/email/cloudflare)
```

- [ ] **Step 2: Write the failing test** — `cloudflare_test.go`

```go
package cloudflare

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/mahdi-awadi/gopkg/communication/provider"
)

// roundTripFunc lets a test stand in for the network.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestSendPostsToEmailServiceREST(t *testing.T) {
	var gotURL, gotAuth string
	var gotBody map[string]any
	rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		gotURL = r.URL.String()
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true}`)), Header: make(http.Header)}, nil
	})
	p := New(Config{AccountID: "acct123", APIToken: "tok", FromEmail: "support@tech-gate.online", FromName: "Support"},
		nil, WithHTTPClient(&http.Client{Transport: rt}))

	resp, err := p.Send(context.Background(), &provider.SendRequest{
		RecipientEmail: "cust@example.com", Subject: "Re: hello", HTMLBody: "<p>hi</p>", Body: "hi",
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got %+v", resp)
	}
	if gotURL != "https://api.cloudflare.com/client/v4/accounts/acct123/email/sending/send" {
		t.Fatalf("url = %s", gotURL)
	}
	if gotAuth != "Bearer tok" {
		t.Fatalf("auth = %s", gotAuth)
	}
	if gotBody["subject"] != "Re: hello" {
		t.Fatalf("body subject = %v (full %v)", gotBody["subject"], gotBody)
	}
}

func TestSendNotVerifiedReturnsProviderError(t *testing.T) {
	rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 403,
			Body:   io.NopCloser(strings.NewReader(`{"success":false,"errors":[{"code":"E_SENDER_NOT_VERIFIED","message":"verify domain"}]}`)),
			Header: make(http.Header)}, nil
	})
	p := New(Config{AccountID: "a", APIToken: "t", FromEmail: "x@y.com"}, nil, WithHTTPClient(&http.Client{Transport: rt}))
	_, err := p.Send(context.Background(), &provider.SendRequest{RecipientEmail: "c@e.com", Subject: "s", Body: "b"})
	if err == nil {
		t.Fatal("expected error for unverified sender")
	}
	var pe *provider.ProviderError
	if !strings.Contains(err.Error(), "E_SENDER_NOT_VERIFIED") {
		t.Fatalf("want CF error code in %v", err)
	}
	_ = pe
}
```

- [ ] **Step 3: Run the test — expect FAIL**

```bash
cd /home/gopkg/communication/email/cloudflare && go test ./...
# Expected: build error / undefined: New, Config, WithHTTPClient
```

- [ ] **Step 4: Implement `cloudflare.go`**

```go
// Package cloudflare implements communication/provider.EmailProvider using the
// Cloudflare Email Service REST API (POST /accounts/{id}/email/sending/send).
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/mahdi-awadi/gopkg/communication/provider"
)

const ProviderCode = "cloudflare"

const apiBase = "https://api.cloudflare.com/client/v4"

// Logger mirrors the minimal logger used by the sendgrid/ses providers.
type Logger interface {
	Info(string, map[string]any)
	Warn(string, map[string]any)
	Error(string, map[string]any)
}

type noopLogger struct{}

func (noopLogger) Info(string, map[string]any)  {}
func (noopLogger) Warn(string, map[string]any)  {}
func (noopLogger) Error(string, map[string]any) {}

// Config holds the Cloudflare Email Service settings.
type Config struct {
	AccountID string
	APIToken  string
	FromEmail string
	FromName  string
}

// Provider implements provider.EmailProvider via Cloudflare Email Service.
type Provider struct {
	cfg    Config
	http   *http.Client
	logger Logger
}

// Option configures a Provider.
type Option func(*Provider)

// WithHTTPClient injects an *http.Client (tests inject a fake transport).
func WithHTTPClient(hc *http.Client) Option { return func(p *Provider) { p.http = hc } }

// New constructs a Cloudflare email Provider. logger may be nil (becomes noop).
func New(cfg Config, logger Logger, opts ...Option) *Provider {
	if logger == nil {
		logger = noopLogger{}
	}
	p := &Provider{cfg: cfg, http: &http.Client{Timeout: 30 * time.Second}, logger: logger}
	for _, o := range opts {
		o(p)
	}
	return p
}

var _ provider.EmailProvider = (*Provider)(nil)

func (p *Provider) Code() string { return ProviderCode }

func (p *Provider) SupportedChannels() []provider.Channel {
	return []provider.Channel{provider.ChannelEmail}
}

func (p *Provider) ValidateConfig() error {
	if p.cfg.AccountID == "" || p.cfg.APIToken == "" || p.cfg.FromEmail == "" {
		return fmt.Errorf("cloudflare: AccountID, APIToken and FromEmail are required")
	}
	return nil
}

func (p *Provider) Enabled() bool {
	return p.cfg.AccountID != "" && p.cfg.APIToken != "" && p.cfg.FromEmail != ""
}

// sendBody is the CF Email Service request payload. NOTE (build-then-verify): the exact
// field names/casing are confirmed against the live API on first real send; adjust the
// json tags here only — the test asserts the URL/auth/subject which are stable.
type sendBody struct {
	From        string            `json:"from"`
	To          []string          `json:"to"`
	Subject     string            `json:"subject"`
	HTML        string            `json:"html,omitempty"`
	Text        string            `json:"text,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Attachments []attach          `json:"attachments,omitempty"`
}

type attach struct {
	Filename string `json:"filename"`
	Type     string `json:"type"`
	Content  string `json:"content"` // base64
}

func (p *Provider) from() string {
	if p.cfg.FromName != "" {
		return fmt.Sprintf("%s <%s>", p.cfg.FromName, p.cfg.FromEmail)
	}
	return p.cfg.FromEmail
}

func (p *Provider) Send(ctx context.Context, req *provider.SendRequest) (*provider.SendResponse, error) {
	return p.send(ctx, req, nil)
}

func (p *Provider) SendWithAttachments(ctx context.Context, req *provider.SendRequest, atts []provider.Attachment) (*provider.SendResponse, error) {
	return p.send(ctx, req, atts)
}

func (p *Provider) send(ctx context.Context, req *provider.SendRequest, atts []provider.Attachment) (*provider.SendResponse, error) {
	if err := p.ValidateConfig(); err != nil {
		return nil, err
	}
	if req.RecipientEmail == "" {
		return nil, provider.NewProviderError(ProviderCode, "E_NO_RECIPIENT", "RecipientEmail is required", false, nil)
	}
	body := sendBody{From: p.from(), To: []string{req.RecipientEmail}, Subject: req.Subject, HTML: req.HTMLBody, Text: req.Body}
	if h, ok := req.Options["headers"].(map[string]string); ok {
		body.Headers = h
	}
	for _, a := range atts {
		body.Attachments = append(body.Attachments, attach{Filename: a.Filename, Type: a.ContentType, Content: base64Std(a.Content)})
	}
	raw, _ := json.Marshal(body)
	url := fmt.Sprintf("%s/accounts/%s/email/sending/send", apiBase, p.cfg.AccountID)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+p.cfg.APIToken)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := p.http.Do(httpReq)
	if err != nil {
		return nil, provider.NewProviderError(ProviderCode, "E_TRANSPORT", "cloudflare send failed", true, err)
	}
	defer resp.Body.Close()
	var parsed struct {
		Success bool `json:"success"`
		Errors  []struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
		Result struct {
			ID string `json:"id"`
		} `json:"result"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&parsed)
	if resp.StatusCode >= 300 || !parsed.Success {
		code, msg := "E_SEND_FAILED", "cloudflare rejected the message"
		if len(parsed.Errors) > 0 {
			code, msg = parsed.Errors[0].Code, parsed.Errors[0].Message
		}
		return nil, provider.NewProviderError(ProviderCode, code, msg, code == "E_TRANSPORT", nil)
	}
	return &provider.SendResponse{Success: true, ProviderCode: ProviderCode, ProviderMessageID: parsed.Result.ID}, nil
}

// GetStatus is not supported by the send API; report unknown.
func (p *Provider) GetStatus(ctx context.Context, messageID string) (*provider.DeliveryStatus, error) {
	return &provider.DeliveryStatus{MessageID: messageID, Status: provider.Status("unknown")}, nil
}
```

Add a tiny base64 helper at the bottom of the same file:

```go
import "encoding/base64" // add to the import block

func base64Std(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
```

- [ ] **Step 5: Run the test — expect PASS**

```bash
cd /home/gopkg/communication/email/cloudflare && go mod tidy && go test ./...
# Expected: ok  github.com/mahdi-awadi/gopkg/communication/email/cloudflare
```

- [ ] **Step 6: Commit**

```bash
cd /home/gopkg && git add communication/email/cloudflare go.work && \
git commit -m "feat(email): cloudflare Email Service provider (outbound)"
```

---

## Task 2: gopkg `communication/email/cloudflare` — inbound parser

**Files:**
- Create: `/home/gopkg/communication/email/cloudflare/inbound.go`
- Test: `/home/gopkg/communication/email/cloudflare/inbound_test.go`

**Interfaces:**
- Produces: `cloudflare.Inbound{From,FromName,To,Subject,Text,HTML,MessageID,InReplyTo}`, `cloudflare.ParseInbound(body []byte) (Inbound, error)`. This is the JSON the Email Worker (Task 5) POSTs.

- [ ] **Step 1: Write the failing test** — `inbound_test.go`

```go
package cloudflare

import "testing"

func TestParseInbound(t *testing.T) {
	body := []byte(`{"from":"cust@example.com","fromName":"Jane","to":"support@tech-gate.online",
		"subject":"Order status?","messageId":"<abc@mail>","inReplyTo":"","text":"where is my order","html":"<p>where is my order</p>"}`)
	in, err := ParseInbound(body)
	if err != nil {
		t.Fatalf("ParseInbound: %v", err)
	}
	if in.From != "cust@example.com" || in.Subject != "Order status?" || in.Text != "where is my order" || in.MessageID != "<abc@mail>" {
		t.Fatalf("parsed wrong: %+v", in)
	}
}

func TestParseInboundRejectsNoFrom(t *testing.T) {
	if _, err := ParseInbound([]byte(`{"subject":"x"}`)); err == nil {
		t.Fatal("expected error when From is missing")
	}
}
```

- [ ] **Step 2: Run — expect FAIL** (`undefined: ParseInbound`)

```bash
cd /home/gopkg/communication/email/cloudflare && go test ./...
```

- [ ] **Step 3: Implement `inbound.go`**

```go
package cloudflare

import (
	"encoding/json"
	"fmt"
)

// Inbound is a normalized email received via the Cloudflare Email Worker.
type Inbound struct {
	From      string `json:"from"`
	FromName  string `json:"fromName"`
	To        string `json:"to"`
	Subject   string `json:"subject"`
	Text      string `json:"text"`
	HTML      string `json:"html"`
	MessageID string `json:"messageId"`
	InReplyTo string `json:"inReplyTo"`
}

// ParseInbound decodes the Email Worker's JSON payload.
func ParseInbound(body []byte) (Inbound, error) {
	var in Inbound
	if err := json.Unmarshal(body, &in); err != nil {
		return Inbound{}, fmt.Errorf("cloudflare: parse inbound: %w", err)
	}
	if in.From == "" {
		return Inbound{}, fmt.Errorf("cloudflare: inbound missing From")
	}
	return in, nil
}
```

- [ ] **Step 4: Run — expect PASS**; **Step 5: Commit**

```bash
cd /home/gopkg/communication/email/cloudflare && go test ./...
cd /home/gopkg && git add communication/email/cloudflare && \
git commit -m "feat(email): cloudflare inbound payload parser"
```

---

## Task 3: Neo `/agent/ingress` + `runCompanyBrief`

**Files:**
- Create: `/home/neo/src/engine/ingress.ts`
- Test: `/home/neo/tests/ingress.test.ts`
- Modify: `/home/neo/src/engine/web-channel.ts` (add `notify`), `/home/neo/src/frontends/web.ts` (endpoint + `ingressSecret` dep), `/home/neo/src/config.ts` (`agentIngressSecret`), `/home/neo/src/daemon.ts` (pass it).

**Interfaces:**
- Consumes: `DispatchDeps` (from `dispatch.ts`), `dispatchMcpServers` (dispatch.ts), `runOrder`/`RunResult` (session-runner.ts), `registry.getDefault()` (registry.ts), `DEFAULT_PROJECT` (default-project.ts).
- Produces: `runCompanyBrief(brief: string, deps: IngressDeps): Promise<string>`, with `IngressDeps = DispatchDeps & { cfg: NeoConfig; run?: typeof runOrder; now?: () => number }`. `CUSTOMER_CHAT = -3`. Endpoint `POST /agent/ingress` → `{ ok: boolean; result: string }`.

- [ ] **Step 1: Write the failing test** — `tests/ingress.test.ts`

```ts
import { test, expect } from "bun:test";
import { runCompanyBrief } from "../src/engine/ingress";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { registerDefaultProject } from "../src/engine/default-project";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";

test("runCompanyBrief runs the brief on the company and returns its result", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  registerDefaultProject(registry, ledger, () => 1); // pins an idle company at /home/neo/agent
  const replies: string[] = [];
  let seenResume: string | undefined;
  const fakeRun = async (_o: Order, h: RunHandlers, d?: { resume?: string }): Promise<RunResult> => {
    seenResume = d?.resume;
    h.onMessage("looked it up");
    return { ok: true, sessionId: "co-1", summary: "order #7 ships tomorrow", costUsd: 0.01 };
  };

  const out = await runCompanyBrief("A customer asks: where is order #7? Answer them.", {
    cfg: {} as never, ledger, registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    reply: (_c, t) => void replies.push(t),
    askApproval: async () => "deny",
    run: fakeRun as never, now: () => 2,
  });

  expect(out).toBe("order #7 ships tomorrow");
  expect(replies).toContain("looked it up");                 // streamed for observability
  expect(registry.getDefault()?.status).toBe("idle");        // company left idle
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd /home/neo && bun test tests/ingress.test.ts
# Expected: Cannot find module '../src/engine/ingress'
```

- [ ] **Step 3: Implement `src/engine/ingress.ts`**

```ts
// The customer-work ingress: run a Gemini-authored brief on the company (default project) and
// return its result. Used by the gateway over HTTP. Customer-driven, so risky tools auto-deny.
import type { NeoConfig } from "../config";
import type { Order } from "../types";
import { runOrder, type RunResult } from "./session-runner";
import { dispatchMcpServers, type DispatchDeps } from "./dispatch";

/** Reserved chat id for company runs driven by a customer brief (never a real operator chat). */
export const CUSTOMER_CHAT = -3;

export type IngressDeps = DispatchDeps & {
  cfg: NeoConfig;
  run?: typeof runOrder;
  now?: () => number;
};

export async function runCompanyBrief(brief: string, deps: IngressDeps): Promise<string> {
  const now = deps.now ?? (() => Date.now());
  const run = deps.run ?? runOrder;
  const company = deps.registry.getDefault();
  if (!company) return "The company is not online right now.";

  const order: Order = { id: crypto.randomUUID(), source: "neo", folder: company.order.folder, task: brief, chatId: CUSTOMER_CHAT, createdAt: now() };
  deps.ledger.recordOrder(order);
  deps.registry.setStatus(company.id, "running");
  deps.registry.touch(company.id, now());

  let result: RunResult;
  try {
    result = await run(
      order,
      {
        onMessage: (t) => void deps.reply(CUSTOMER_CHAT, t, company.name),
        onEscalation: async () => "deny", // customer-driven work never auto-performs risky actions
        onRateLimit: (info) => deps.usage?.noteRateLimit(info),
      },
      { resume: company.sdkSessionId || undefined, effort: "low", mcpServers: dispatchMcpServers(deps, CUSTOMER_CHAT) },
    );
  } catch (e) {
    deps.registry.setStatus(company.id, "idle");
    return `The company hit an error: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (result.sessionId) {
    deps.registry.setSdkSessionId(company.id, result.sessionId);
    deps.ledger.recordSession(order.id, result.sessionId);
  }
  deps.meter.note({ costUsd: result.costUsd }, now());
  deps.registry.setStatus(company.id, "idle");
  deps.registry.touch(company.id, now());
  return result.summary || (result.ok ? "Done." : "The company couldn't complete that.");
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd /home/neo && bun test tests/ingress.test.ts
```

- [ ] **Step 5: Add `notify` to the web channel** — `src/engine/web-channel.ts`, inside the returned object (next to `state()`):

```ts
    notify(text: string, project?: string) {
      message(text, project); // reuse the existing markdown→HTML message emitter
    },
```

And add to the `WebChannel` interface:

```ts
  /** Push a line into the operator feed (used to surface customer-driven company work). */
  notify(text: string, project?: string): void;
```

- [ ] **Step 6: Add config + endpoint.** In `src/config.ts` add to `NeoConfig` and `DEFAULTS`/loader: `agentIngressSecret: string` (from `process.env.AGENT_INGRESS_SECRET ?? ""`). In `src/frontends/web.ts` add `ingressSecret?: string` to `WebAppDeps`, pass `deps.engine`/`deps.usage` already present, and add this handler **before** the `sessionUser` gate (machine-to-machine auth, not the cookie):

```ts
    if (req.method === "POST" && path === "/agent/ingress") {
      const auth = req.headers.get("authorization") ?? "";
      if (!deps.ingressSecret || auth !== `Bearer ${deps.ingressSecret}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = (await req.json().catch(() => ({}))) as { brief?: unknown };
      if (typeof body.brief !== "string" || !body.brief.trim()) {
        return Response.json({ ok: false, result: "missing brief" }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const result = await runCompanyBrief(body.brief.trim(), {
        cfg: deps.engine.cfg, ledger: deps.engine.ledger, registry: deps.engine.registry,
        meter: deps.engine.meter, usage: deps.usage,
        reply: (_c, text, project) => channel.notify(text, project),
        askApproval: async () => "deny",
      });
      return Response.json({ ok: true, result }, { headers: { "cache-control": "no-store" } });
    }
```

Add the import at the top of `web.ts`: `import { runCompanyBrief } from "../engine/ingress";`. In `src/daemon.ts`, pass `ingressSecret: cfg.agentIngressSecret` into the `startWeb({...})` deps object.

- [ ] **Step 7: Verify the whole suite + types, then commit**

```bash
cd /home/neo && bunx tsc --noEmit && bun test
# Expected: tsc clean; all tests pass (existing config-literal tests may need agentIngressSecret added — update those test fixtures to include `agentIngressSecret: ""`).
git add src/ tests/ && git commit -m "feat(neo): /agent/ingress — run a customer brief on the company (Phase 3b bridge)"
```

---

## Task 4: The Go gateway service

**Files (all under `/home/neo/gateway/`):** `go.mod`, `go.work`, `config.go`, `memstore.go`, `ingress.go`, `orchestrate.go`, `inbound.go`, `server.go`, `main.go`, and tests `orchestrate_test.go`, `inbound_test.go`. `.env.example`.

**Interfaces:**
- Consumes: `communication/email/cloudflare` (`New`, `Config`, `ParseInbound`, `Inbound`), `communication/provider` (`EmailProvider`, `SendRequest`), `ai/llm` (`NewRegistry`, `Registry`, `ToolDecl`, `ToolSchema`, `ToolProperty`, `ToolCall`), `ai/llm/geminitext` (`New`), `ai/orchestrator` (`Process`, `Config`, `ToolDispatcher`, `Result`), `ai/conversation` (`Message`, `Cache`, `KeyForUser`).
- Produces: `gateway.Config`, `gateway.memCache` (in-process `conversation.Cache`), `gateway.IngressClient.Dispatch(ctx, brief) (string, error)`, `gateway.handleInbound`, the `dispatch_to_company` tool wiring.

- [ ] **Step 1: Scaffold the module + workspace**

```bash
mkdir -p /home/neo/gateway
cd /home/neo/gateway
go mod init github.com/mahdi-awadi/neo-gateway
cat > go.work <<'EOF'
go 1.26
use (
	.
	../gopkg/ai/conversation
	../gopkg/ai/llm
	../gopkg/ai/llm/geminitext
	../gopkg/ai/orchestrator
	../gopkg/communication/provider
	../gopkg/communication/email/cloudflare
)
EOF
```

- [ ] **Step 2: In-memory conversation cache — failing test** `orchestrate_test.go` (start with the memCache + the tool dispatcher):

```go
package main

import (
	"context"
	"testing"

	"github.com/mahdi-awadi/gopkg/ai/conversation"
	"github.com/mahdi-awadi/gopkg/ai/llm"
)

func TestMemCacheAppendRecent(t *testing.T) {
	c := newMemCache()
	ctx := context.Background()
	_ = c.Append(ctx, "k", conversation.Message{Role: "user", Content: "hi"})
	_ = c.Append(ctx, "k", conversation.Message{Role: "model", Content: "hello"})
	got, _ := c.Recent(ctx, "k", 10)
	if len(got) != 2 || got[1].Content != "hello" {
		t.Fatalf("recent = %+v", got)
	}
}

func TestCompanyToolDispatcherCallsIngress(t *testing.T) {
	var gotBrief string
	disp := companyDispatcher(ingressFunc(func(_ context.Context, brief string) (string, error) {
		gotBrief = brief
		return "order ships tomorrow", nil
	}))
	out, err := disp(context.Background(), llm.ToolCall{Name: "dispatch_to_company", Args: map[string]any{"brief": "find order #7"}})
	if err != nil {
		t.Fatal(err)
	}
	if gotBrief != "find order #7" || out != "order ships tomorrow" {
		t.Fatalf("brief=%q out=%v", gotBrief, out)
	}
}
```

- [ ] **Step 3: Run — expect FAIL**; **Step 4: Implement `memstore.go` + `ingress.go` + `orchestrate.go`**

`memstore.go`:

```go
package main

import (
	"context"
	"sync"

	"github.com/mahdi-awadi/gopkg/ai/conversation"
)

// memCache is an in-process conversation.Cache (no Redis for the MVP).
type memCache struct {
	mu sync.Mutex
	m  map[string][]conversation.Message
}

func newMemCache() *memCache { return &memCache{m: map[string][]conversation.Message{}} }

func (c *memCache) Get(_ context.Context, key string) ([]conversation.Message, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]conversation.Message(nil), c.m[key]...), nil
}
func (c *memCache) Append(_ context.Context, key string, msg conversation.Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] = append(c.m[key], msg)
	return nil
}
func (c *memCache) Recent(_ context.Context, key string, n int) ([]conversation.Message, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	all := c.m[key]
	if n > 0 && len(all) > n {
		all = all[len(all)-n:]
	}
	return append([]conversation.Message(nil), all...), nil
}
func (c *memCache) Clear(_ context.Context, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.m, key)
	return nil
}

var _ conversation.Cache = (*memCache)(nil)
```

`ingress.go`:

```go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// ingressFunc dispatches a brief to the Neo company and returns its result text.
type ingressFunc func(ctx context.Context, brief string) (string, error)

// neoIngress posts a brief to the Neo /agent/ingress endpoint.
func neoIngress(url, secret string, hc *http.Client) ingressFunc {
	return func(ctx context.Context, brief string) (string, error) {
		raw, _ := json.Marshal(map[string]string{"brief": brief})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bearer "+secret)
		req.Header.Set("Content-Type", "application/json")
		resp, err := hc.Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return "", fmt.Errorf("neo ingress: status %d", resp.StatusCode)
		}
		var out struct {
			OK     bool   `json:"ok"`
			Result string `json:"result"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			return "", err
		}
		return out.Result, nil
	}
}
```

`orchestrate.go`:

```go
package main

import (
	"context"
	"fmt"

	"github.com/mahdi-awadi/gopkg/ai/llm"
	"github.com/mahdi-awadi/gopkg/ai/orchestrator"
)

// companyTool is the single tool exposed to Gemini.
var companyTool = llm.ToolDecl{
	Name:        "dispatch_to_company",
	Description: "Hand a self-contained work brief to the company (the operator's back office) and get its result. Use for anything that needs real work, lookups, or action beyond what you can answer directly. The company does not see the customer's message — only your brief — so write a clear, complete brief.",
	Parameters: llm.ToolSchema{
		Type:     "object",
		Required: []string{"brief"},
		Properties: map[string]llm.ToolProperty{
			"brief": {Type: "string", Description: "a clear, self-contained brief/prompt for the company to execute"},
		},
	},
}

// companyDispatcher turns the model's tool call into a Neo ingress call.
func companyDispatcher(ingress ingressFunc) orchestrator.ToolDispatcher {
	return func(ctx context.Context, call llm.ToolCall) (any, error) {
		brief, _ := call.Args["brief"].(string)
		if brief == "" {
			return nil, fmt.Errorf("dispatch_to_company: empty brief")
		}
		return ingress(ctx, brief)
	}
}

const systemPrompt = `You are the customer support agent for the business. Be warm, concise, and helpful.
Answer simple questions directly. For anything needing real work, a lookup, or an action, call
dispatch_to_company with a clear self-contained brief and use its result to write your reply.
Never promise actions you haven't confirmed via the tool.`

// replyForInbound runs one Gemini pass over the inbound text and returns the assistant reply.
func replyForInbound(ctx context.Context, reg *llm.Registry, ingress ingressFunc, history []conversationMessage, userText string) (string, error) {
	res, err := orchestrator.Process(ctx, reg, orchestrator.Config{
		SystemPrompt: systemPrompt,
		Tools:        []llm.ToolDecl{companyTool},
		History:      toConvHistory(history),
		MaxToolHops:  4,
		Dispatcher:   companyDispatcher(ingress),
	}, userText)
	if err != nil {
		return "", err
	}
	return res.AssistantText, nil
}
```

(`conversationMessage`/`toConvHistory` are thin aliases over `conversation.Message` defined in `inbound.go` next; keep them so the signature reads clearly.)

- [ ] **Step 5: Run — expect PASS**

```bash
cd /home/neo/gateway && go mod tidy && go test ./...
```

- [ ] **Step 6: Inbound handler — failing test** `inbound_test.go`:

```go
package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mahdi-awadi/gopkg/communication/provider"
)

// fakeSender records the reply instead of calling Cloudflare.
type fakeSender struct{ last *provider.SendRequest }

func (f *fakeSender) Code() string                          { return "fake" }
func (f *fakeSender) SupportedChannels() []provider.Channel { return []provider.Channel{provider.ChannelEmail} }
func (f *fakeSender) ValidateConfig() error                 { return nil }
func (f *fakeSender) Enabled() bool                         { return true }
func (f *fakeSender) GetStatus(context.Context, string) (*provider.DeliveryStatus, error) {
	return &provider.DeliveryStatus{}, nil
}
func (f *fakeSender) SendWithAttachments(ctx context.Context, r *provider.SendRequest, _ []provider.Attachment) (*provider.SendResponse, error) {
	return f.Send(ctx, r)
}
func (f *fakeSender) Send(_ context.Context, r *provider.SendRequest) (*provider.SendResponse, error) {
	f.last = r
	return &provider.SendResponse{Success: true}, nil
}

func TestHandleInboundDispatchesAndReplies(t *testing.T) {
	sender := &fakeSender{}
	// a reply func that doesn't touch Gemini: pretend the model answered using the tool result.
	reply := func(_ context.Context, _ []conversationMessage, userText string) (string, error) {
		return "Thanks for reaching out — " + userText, nil
	}
	gw := &gateway{sender: sender, store: newMemCache(), inboundSecret: "s", replyFn: reply, fromEmail: "support@tech-gate.online"}

	body := []byte(`{"from":"cust@example.com","subject":"hi","text":"where is my order","messageId":"<m1>"}`)
	req := httptest.NewRequest(http.MethodPost, "/inbound/email", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer s")
	rec := httptest.NewRecorder()
	gw.handleInbound(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if sender.last == nil || sender.last.RecipientEmail != "cust@example.com" {
		t.Fatalf("reply not sent to sender: %+v", sender.last)
	}
	if sender.last.Body == "" {
		t.Fatalf("empty reply body")
	}
}

func TestHandleInboundRejectsBadSecret(t *testing.T) {
	gw := &gateway{inboundSecret: "s", store: newMemCache()}
	req := httptest.NewRequest(http.MethodPost, "/inbound/email", bytes.NewReader([]byte(`{}`)))
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	gw.handleInbound(rec, req)
	if rec.Code != 401 {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}
```

- [ ] **Step 7: Implement `inbound.go` + `server.go`**

`inbound.go`:

```go
package main

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/mahdi-awadi/gopkg/ai/conversation"
	"github.com/mahdi-awadi/gopkg/communication/email/cloudflare"
	"github.com/mahdi-awadi/gopkg/communication/provider"
)

// conversationMessage is an alias so signatures read clearly.
type conversationMessage = conversation.Message

func toConvHistory(h []conversationMessage) []conversation.Message { return h }

// replyFunc produces the assistant reply for an inbound text (Gemini in prod, a fake in tests).
type replyFunc func(ctx context.Context, history []conversationMessage, userText string) (string, error)

type gateway struct {
	sender        provider.EmailProvider
	store         conversation.Cache
	inboundSecret string
	replyFn       replyFunc
	fromEmail     string
}

func (g *gateway) handleInbound(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+g.inboundSecret {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	raw, _ := io.ReadAll(r.Body)
	in, err := cloudflare.ParseInbound(raw)
	if err != nil {
		http.Error(w, "bad payload", http.StatusUnprocessableEntity)
		return
	}
	ctx := r.Context()
	key := "email:" + in.From
	history, _ := g.store.Recent(ctx, key, 20)
	_ = g.store.Append(ctx, key, conversation.Message{Role: "user", Channel: "email", Content: in.Text, Timestamp: time.Now()})

	answer, err := g.replyFn(ctx, history, in.Text)
	if err != nil {
		http.Error(w, "processing error", http.StatusBadGateway)
		return
	}
	_ = g.store.Append(ctx, key, conversation.Message{Role: "model", Channel: "email", Content: answer, Timestamp: time.Now()})

	subject := in.Subject
	if subject != "" && len(subject) >= 3 && subject[:3] != "Re:" {
		subject = "Re: " + subject
	}
	opts := map[string]any{}
	if in.MessageID != "" {
		opts["headers"] = map[string]string{"In-Reply-To": in.MessageID, "References": in.MessageID}
	}
	_, sendErr := g.sender.Send(ctx, &provider.SendRequest{
		RecipientEmail: in.From, Subject: subject, Body: answer, Options: opts,
	})
	if sendErr != nil {
		http.Error(w, "send failed", http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusOK)
}
```

`server.go`:

```go
package main

import "net/http"

func (g *gateway) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /inbound/email", g.handleInbound)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	return mux
}
```

- [ ] **Step 8: Run — expect PASS**

```bash
cd /home/neo/gateway && go test ./...
```

- [ ] **Step 9: Implement `config.go` + `main.go` (wiring; no new test — covered by the unit tests + the live e2e in Task 6)**

`config.go`:

```go
package main

import (
	"fmt"
	"os"
)

type Config struct {
	ListenAddr        string
	GeminiAPIKey      string
	GeminiModel       string
	CFAccountID       string
	CFEmailAPIToken   string
	EmailFrom         string
	EmailFromName     string
	InboundSecret     string
	NeoIngressURL     string
	NeoIngressSecret  string
}

func loadConfig() (Config, error) {
	c := Config{
		ListenAddr:       envOr("LISTEN_ADDR", ":8080"),
		GeminiAPIKey:     os.Getenv("GEMINI_API_KEY"),
		GeminiModel:      envOr("GEMINI_MODEL", "gemini-2.5-flash"),
		CFAccountID:      os.Getenv("CF_ACCOUNT_ID"),
		CFEmailAPIToken:  os.Getenv("CF_EMAIL_API_TOKEN"),
		EmailFrom:        envOr("EMAIL_FROM", "support@tech-gate.online"),
		EmailFromName:    envOr("EMAIL_FROM_NAME", "Support"),
		InboundSecret:    os.Getenv("INBOUND_WEBHOOK_SECRET"),
		NeoIngressURL:    os.Getenv("NEO_INGRESS_URL"),
		NeoIngressSecret: os.Getenv("NEO_INGRESS_SECRET"),
	}
	for k, v := range map[string]string{"GEMINI_API_KEY": c.GeminiAPIKey, "CF_ACCOUNT_ID": c.CFAccountID, "CF_EMAIL_API_TOKEN": c.CFEmailAPIToken, "INBOUND_WEBHOOK_SECRET": c.InboundSecret, "NEO_INGRESS_URL": c.NeoIngressURL, "NEO_INGRESS_SECRET": c.NeoIngressSecret} {
		if v == "" {
			return Config{}, fmt.Errorf("missing required env %s", k)
		}
	}
	return c, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
```

`main.go`:

```go
package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/mahdi-awadi/gopkg/ai/llm"
	"github.com/mahdi-awadi/gopkg/ai/llm/geminitext"
	"github.com/mahdi-awadi/gopkg/communication/email/cloudflare"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	reg := llm.NewRegistry()
	reg.Register(geminitext.New("gemini", cfg.GeminiAPIKey, cfg.GeminiModel))

	ingress := neoIngress(cfg.NeoIngressURL, cfg.NeoIngressSecret, &http.Client{Timeout: 4 * time.Minute})
	sender := cloudflare.New(cloudflare.Config{
		AccountID: cfg.CFAccountID, APIToken: cfg.CFEmailAPIToken, FromEmail: cfg.EmailFrom, FromName: cfg.EmailFromName,
	}, nil)

	gw := &gateway{
		sender:        sender,
		store:         newMemCache(),
		inboundSecret: cfg.InboundSecret,
		fromEmail:     cfg.EmailFrom,
		replyFn: func(ctx context.Context, history []conversationMessage, userText string) (string, error) {
			return replyForInbound(ctx, reg, ingress, history, userText)
		},
	}
	log.Printf("neo-gateway listening on %s (from=%s)", cfg.ListenAddr, cfg.EmailFrom)
	log.Fatal(http.ListenAndServe(cfg.ListenAddr, gw.routes()))
}
```

- [ ] **Step 10: Build + commit**

```bash
cd /home/neo/gateway && go build ./... && go test ./...
git init -q && git add -A && git commit -q -m "feat(neo-gateway): Go customer gateway — inbound email → Gemini → dispatch_to_company → reply"
# (Decide with the operator whether neo-gateway is its own repo or a subtree; default: its own repo.)
```

---

## Task 5: Cloudflare Email Worker (inbound bridge)

**Files (under `/home/neo/gateway/worker/`):** `worker.js`, `wrangler.toml`, `package.json`. Verified by live round-trip (no unit test — it runs on Cloudflare).

- [ ] **Step 1: `package.json`** (pull in the MIME parser)

```json
{ "name": "neo-email-worker", "private": true, "dependencies": { "postal-mime": "^2.2.0" } }
```

- [ ] **Step 2: `worker.js`**

```js
import PostalMime from "postal-mime";

export default {
  async email(message, env, ctx) {
    const parsed = await PostalMime.parse(message.raw);
    const payload = {
      from: message.from,
      fromName: parsed.from?.name || "",
      to: message.to,
      subject: parsed.subject || "",
      messageId: parsed.messageId || "",
      inReplyTo: parsed.inReplyTo || "",
      text: parsed.text || "",
      html: parsed.html || "",
    };
    await fetch(env.GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.INBOUND_WEBHOOK_SECRET}` },
      body: JSON.stringify(payload),
    });
  },
};
```

- [ ] **Step 3: `wrangler.toml`**

```toml
name = "neo-email-worker"
main = "worker.js"
compatibility_date = "2026-06-01"

[vars]
GATEWAY_URL = "https://neo-api.tech-gate.online/inbound/email"
# INBOUND_WEBHOOK_SECRET set via: wrangler secret put INBOUND_WEBHOOK_SECRET
```

- [ ] **Step 4: Deploy + route (operator runs)**

```bash
cd /home/neo/gateway/worker && npm install
npx wrangler secret put INBOUND_WEBHOOK_SECRET     # paste the same secret the gateway uses
npx wrangler deploy
# In the Cloudflare dashboard → Email → Email Routing: route support@tech-gate.online to this Worker.
```

- [ ] **Step 5: Commit**

```bash
cd /home/neo/gateway && git add worker && git commit -q -m "feat(neo-gateway): Cloudflare Email Worker — inbound mail → gateway"
```

---

## Task 6: Containerize + Traefik + live end-to-end

**Files:** `/home/neo/gateway/Dockerfile`, `/home/neo/gateway/.dockerignore`, `/home/neo/gateway/.env.example`, `/home/traefik/dynamic/neo-api.yml`, and a compose entry.

- [ ] **Step 1: `Dockerfile`** (build context is `/home` so it can copy both `gopkg` and `neo-gateway` + the workspace)

```dockerfile
# build from /home:  docker build -f neo-gateway/Dockerfile -t neo-gateway /home
FROM golang:1.26 AS build
WORKDIR /src
COPY gopkg/ ./gopkg/
COPY neo-gateway/ ./neo-gateway/
WORKDIR /src/neo-gateway
RUN go build -o /out/neo-gateway .

FROM gcr.io/distroless/base-debian12
COPY --from=build /out/neo-gateway /neo-gateway
EXPOSE 8080
ENTRYPOINT ["/neo-gateway"]
```

The `neo-gateway/go.work` already points at `../gopkg/...`, which resolves to `/src/gopkg/...` inside the image — so the local modules build without publishing.

- [ ] **Step 2: `.env.example`** (operator copies to `.env`, `chmod 600`)

```
LISTEN_ADDR=:8080
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
CF_ACCOUNT_ID=
CF_EMAIL_API_TOKEN=
EMAIL_FROM=support@tech-gate.online
EMAIL_FROM_NAME=Support
INBOUND_WEBHOOK_SECRET=
NEO_INGRESS_URL=http://172.20.0.1:3003/agent/ingress
NEO_INGRESS_SECRET=
```

- [ ] **Step 3: Build + run the container**

```bash
docker build -f /home/neo/gateway/Dockerfile -t neo-gateway /home
docker run -d --name neo-gateway --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  --env-file /home/neo/gateway/.env \
  --network <the-traefik-docker-network> \
  --label "traefik.enable=true" \
  --label "traefik.http.routers.neoapi.rule=Host(\`neo-api.tech-gate.online\`)" \
  --label "traefik.http.routers.neoapi.entrypoints=websecure" \
  --label "traefik.http.routers.neoapi.tls.certresolver=cloudflare" \
  --label "traefik.http.services.neoapi.loadbalancer.server.port=8080" \
  neo-gateway
# (If Traefik uses file-provider instead of docker labels, add /home/traefik/dynamic/neo-api.yml
#  mirroring /home/traefik/dynamic/neo.yml, routing neo-api.tech-gate.online -> the container.)
```

Set `NEO_INGRESS_URL=http://172.20.0.1:3003/agent/ingress` (Neo binds the docker-bridge IP) and ensure `AGENT_INGRESS_SECRET` in Neo's `.env` equals `NEO_INGRESS_SECRET`; restart Neo (`systemctl restart neo`).

- [ ] **Step 4: Live end-to-end verification**

```bash
# 1. health
curl -s https://neo-api.tech-gate.online/healthz   # -> ok
# 2. bridge (from the host, on the docker bridge):
curl -s -X POST http://172.20.0.1:3003/agent/ingress \
  -H "authorization: Bearer $AGENT_INGRESS_SECRET" -H 'content-type: application/json' \
  -d '{"brief":"In one sentence, confirm the company is reachable."}'   # -> {"ok":true,"result":"..."}
# 3. real email: send a message to support@tech-gate.online from a personal inbox.
#    Expect: a reply email; the company run visible in the Neo dashboard feed (tagged).
```

- [ ] **Step 5: Commit + record**

```bash
cd /home/neo/gateway && git add Dockerfile .dockerignore .env.example && \
git commit -q -m "feat(neo-gateway): containerize + Traefik route (neo-api.tech-gate.online) + live e2e"
# Update /home/neo/docs and MVP-PLAN.md Phase 3b: email slice complete.
```

---

## Self-Review

**1. Spec coverage:**
- gopkg `email` package (both directions) → Tasks 1 (send) + 2 (inbound parse), built as `communication/email/cloudflare` to match the existing `sendgrid`/`ses` pattern (a refinement of the spec's "new `email` package" — the spec's intent, reusable email in gopkg, is met).
- Cloudflare Email Worker → Task 5. Gateway service → Task 4. Neo ingress → Task 3. Container + Traefik + subdomain `neo-api.tech-gate.online` → Task 6. Compliance (no Claude creds in the container; `source:"customer"` firewall intact) → enforced by Task 6 env split + unchanged router. Conversation memory → Task 4 `memCache`. Testing strategy → each task is TDD; live e2e in Task 6.

**2. Placeholder scan:** No "TBD/TODO". Two explicit **build-then-verify** notes (CF send JSON field casing in Task 1; Traefik provider style in Task 6) are flagged with the exact thing to confirm, not left vague.

**3. Type consistency:** `provider.SendRequest`/`SendResponse`/`Attachment`/`EmailProvider`, `cloudflare.Config/New/ParseInbound/Inbound`, `orchestrator.Process/Config/ToolDispatcher`, `llm.NewRegistry/ToolDecl/ToolSchema/ToolProperty/ToolCall`, `geminitext.New`, `conversation.Message/Cache`, and the Neo `runCompanyBrief(brief, IngressDeps)` + `CUSTOMER_CHAT` are used identically across tasks. The gateway's `replyFunc`/`ingressFunc`/`gateway` struct fields match between the tests and the implementations.

## Notes for the operator (provide before/at Task 6)

- Cloudflare: Email Routing on the domain (catch `support@`), a **verified sender domain + DKIM** for Email Service, and an API token scoped to email send (→ `CF_EMAIL_API_TOKEN`, `CF_ACCOUNT_ID`).
- The shared secrets: pick `INBOUND_WEBHOOK_SECRET` and `NEO_INGRESS_SECRET`/`AGENT_INGRESS_SECRET` (long random strings).
- Confirm the Traefik network/provider style so Task 6 uses labels vs the file provider correctly.
