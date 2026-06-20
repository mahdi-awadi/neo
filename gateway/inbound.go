package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

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
	sender        emailSender
	store         conversation.Cache
	gatewaySecret string
	replyFn       replyFunc
	fromEmail     string
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
	log.Printf("inbound from %s subj=%q", in.From, in.Subject)
	ctx := r.Context()
	key := conversation.KeyForUser("email", in.From)
	history, _ := g.store.Recent(ctx, key, 20)
	_ = g.store.Append(ctx, key, conversation.Message{Role: "user", Channel: "email", Content: in.Text, Timestamp: time.Now()})

	answer, err := g.replyFn(ctx, history, in.Text)
	if err != nil {
		log.Printf("inbound: reply generation failed for %s: %v", in.From, err)
		http.Error(w, "processing error", http.StatusBadGateway)
		return
	}
	_ = g.store.Append(ctx, key, conversation.Message{Role: "model", Channel: "email", Content: answer, Timestamp: time.Now()})

	subject := in.Subject
	if subject != "" && !strings.HasPrefix(subject, "Re:") {
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
		log.Printf("inbound: send failed to %s: %v", in.From, sendErr)
		http.Error(w, "send failed", http.StatusBadGateway)
		return
	}
	log.Printf("inbound: replied to %s", in.From)
	w.WriteHeader(http.StatusOK)
}
