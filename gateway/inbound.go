package main

import (
	"context"
	"io"
	"log"
	"net/http"

	"github.com/mahdi-awadi/gopkg/ai/conversation"
	"github.com/mahdi-awadi/gopkg/communication/email/cloudflare"
	"github.com/mahdi-awadi/gopkg/communication/provider"
)

// emailSender is the subset the handler needs (cloudflare provider OR workerSender satisfy it).
type emailSender interface {
	Send(ctx context.Context, req *provider.SendRequest) (*provider.SendResponse, error)
}

// conversationMessage is an alias so signatures read clearly.
type conversationMessage = conversation.Message

func toConvHistory(h []conversationMessage) []conversation.Message { return h }

// replyFunc produces the assistant reply for an inbound text (Gemini in prod, a fake in tests).
type replyFunc func(ctx context.Context, history []conversationMessage, userText string) (string, error)

type gateway struct {
	gatewaySecret string
	inboxFn       inboxFunc // inbound → Neo inbox (no AI). The only thing handleInbound needs.
	neoSecret     string    // Neo→gateway shared secret for POST /send (operator-approved replies)
	sender        emailSender
	// Kept for later operator-triggered draft steps, not the inbound path:
	store     conversation.Cache
	replyFn   replyFunc
	fromEmail string
}

func (g *gateway) handleInbound(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+g.gatewaySecret {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	raw, _ := io.ReadAll(r.Body)
	in, err := cloudflare.ParseInbound(raw)
	if err != nil {
		log.Printf("inbound: bad payload: %v", err)
		http.Error(w, "bad payload", http.StatusUnprocessableEntity)
		return
	}
	// Park it in Neo's inbox for the operator to review. NO AI, NO auto-reply — the customer's
	// message is just stored and shown in the dashboard. The agent is invoked later, only when
	// the operator sends the item to it.
	if err := g.inboxFn(r.Context(), in); err != nil {
		log.Printf("inbound: forward to inbox failed for %s: %v", in.From, err)
		http.Error(w, "inbox unavailable", http.StatusBadGateway)
		return
	}
	log.Printf("inbound queued from %s subj=%q", in.From, in.Subject)
	w.WriteHeader(http.StatusOK)
}
