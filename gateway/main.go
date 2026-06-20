package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/mahdi-awadi/gopkg/ai/llm"
	"github.com/mahdi-awadi/gopkg/ai/llm/geminitext"
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
		inboxFn:       inbox, // inbound mail → Neo inbox (no AI, no auto-reply)
		neoSecret:     cfg.NeoIngressSecret, // Neo→gateway auth for POST /send
		sender:        sender,
		store:         newMemCache(),
		fromEmail:     cfg.EmailFrom,
		replyFn: func(ctx context.Context, history []conversationMessage, userText string) (string, error) {
			return replyForInbound(ctx, reg, ingress, history, userText)
		},
	}
	log.Printf("neo-gateway listening on %s (from=%s)", cfg.ListenAddr, cfg.EmailFrom)
	log.Fatal(http.ListenAndServe(cfg.ListenAddr, gw.routes()))
}
