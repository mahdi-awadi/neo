package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/mahdi-awadi/gopkg/ai/llm"
	"github.com/mahdi-awadi/gopkg/ai/llm/geminitext"
	twiliowa "github.com/mahdi-awadi/gopkg/communication/whatsapp/twilio"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	reg := llm.NewRegistry()
	reg.Register(geminitext.New("gemini", cfg.GeminiAPIKey, cfg.GeminiModel))

	ingress := neoIngress(cfg.NeoIngressURL, cfg.NeoIngressSecret, &http.Client{Timeout: 4 * time.Minute})
	sender := newWorkerSender(cfg.WorkerSendURL, cfg.GatewayWorkerSecret, cfg.EmailFrom, cfg.EmailFromName, &http.Client{Timeout: 30 * time.Second})
	inbox := neoInbox(cfg.NeoInboxURL, cfg.NeoIngressSecret, &http.Client{Timeout: 30 * time.Second})

	gw := &gateway{
		gatewaySecret: cfg.GatewayWorkerSecret,
		inboxFn:       inbox,                // inbound mail → Neo inbox (no AI, no auto-reply)
		neoSecret:     cfg.NeoIngressSecret, // Neo→gateway auth for POST /send
		sender:        sender,
		store:         newMemCache(),
		fromEmail:     cfg.EmailFrom,
		replyFn: func(ctx context.Context, history []conversationMessage, userText string) (string, error) {
			return replyForInbound(ctx, reg, ingress, history, userText)
		},
	}

	// WhatsApp (Gemini front-desk channel) — optional; activates when Twilio creds are present.
	if cfg.TwilioAccountSID != "" && cfg.TwilioAuthToken != "" && cfg.TwilioWhatsAppFrom != "" {
		handoff := neoHandoff(cfg.NeoInboxURL, cfg.NeoIngressSecret, &http.Client{Timeout: 30 * time.Second})
		gw.waSender = twiliowa.New(twiliowa.Config{
			AccountSID: cfg.TwilioAccountSID,
			AuthToken:  cfg.TwilioAuthToken,
			From:       cfg.TwilioWhatsAppFrom,
		}, nil)
		gw.twilioAuthToken = cfg.TwilioAuthToken
		gw.publicURL = cfg.PublicURL
		gw.waReplyFn = func(ctx context.Context, sender, name string, history []conversationMessage, userText string) (string, error) {
			return replyForWhatsApp(ctx, reg, ingress, handoff, sender, name, history, userText)
		}
		log.Printf("neo-gateway: WhatsApp front-desk enabled (Gemini triage → operator handoff, from=%s)", cfg.TwilioWhatsAppFrom)
	}

	log.Printf("neo-gateway listening on %s (from=%s)", cfg.ListenAddr, cfg.EmailFrom)
	log.Fatal(http.ListenAndServe(cfg.ListenAddr, gw.routes()))
}
