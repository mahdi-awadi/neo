package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/mahdi-awadi/gopkg/ai/conversation"
	"github.com/mahdi-awadi/gopkg/communication/provider"
)

// whatsappSender is the subset of the Twilio WhatsApp provider the handler needs (the concrete
// gopkg provider satisfies it; tests inject a fake).
type whatsappSender interface {
	Send(ctx context.Context, req *provider.SendRequest) (*provider.SendResponse, error)
}

// handleInboundWhatsApp: a customer WhatsApp message arrives via Twilio's webhook. Unlike the email
// path (which parks for operator review), WhatsApp is an AUTONOMOUS Gemini channel — Gemini answers
// live, calling dispatch_to_company for real work. Compliance unchanged: Gemini faces the customer,
// never Claude; real work still flows only through the brief → Neo ingress → company. (To make
// WhatsApp human-in-the-loop instead, route to inboxFn like the email path — the inbox is
// channel-agnostic.)
func (g *gateway) handleInboundWhatsApp(w http.ResponseWriter, r *http.Request) {
	if g.waSender == nil || g.twilioAuthToken == "" {
		http.Error(w, "whatsapp not configured", http.StatusServiceUnavailable)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	// Twilio signs each webhook; validate against the gateway's public URL for this route.
	if !twilioSignatureValid(g.twilioAuthToken, g.publicURL+"/inbound/whatsapp", r.PostForm, r.Header.Get("X-Twilio-Signature")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	sender := strings.TrimPrefix(r.PostForm.Get("From"), "whatsapp:")
	name := r.PostForm.Get("ProfileName")
	body := strings.TrimSpace(r.PostForm.Get("Body"))
	if sender == "" || body == "" {
		w.WriteHeader(http.StatusOK) // status callback / empty — nothing to answer
		return
	}
	key := "whatsapp:" + sender

	history, _ := g.store.Recent(r.Context(), key, 20)
	// The Gemini front-desk: discusses to understand intent, hands a summary to the operator
	// (handoff_to_operator → Neo inbox), and answers/dispatches as needed. Reply = what the
	// customer sees; the handoff is a side-effect posted to the inbox.
	reply, err := g.waReplyFn(r.Context(), sender, name, history, body)
	if err != nil {
		log.Printf("whatsapp: reply failed for %s: %v", maskPhone(sender), err)
		http.Error(w, "reply failed", http.StatusBadGateway)
		return
	}
	if _, err := g.waSender.Send(r.Context(), &provider.SendRequest{RecipientPhone: sender, Body: reply}); err != nil {
		log.Printf("whatsapp: send failed for %s: %v", maskPhone(sender), err)
		http.Error(w, "send failed", http.StatusBadGateway)
		return
	}
	_ = g.store.Append(r.Context(), key, conversation.Message{Role: "user", Content: body})
	_ = g.store.Append(r.Context(), key, conversation.Message{Role: "model", Content: reply})
	log.Printf("whatsapp: answered %s", maskPhone(sender))
	w.WriteHeader(http.StatusOK)
}

// twilioSignatureValid validates Twilio's X-Twilio-Signature: base64(HMAC-SHA1(authToken,
// fullURL + each POST param appended sorted by key)). See Twilio webhook security.
func twilioSignatureValid(authToken, fullURL string, form url.Values, sig string) bool {
	if authToken == "" || sig == "" {
		return false
	}
	keys := make([]string, 0, len(form))
	for k := range form {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(fullURL)
	for _, k := range keys {
		b.WriteString(k)
		b.WriteString(form.Get(k))
	}
	mac := hmac.New(sha1.New, []byte(authToken))
	mac.Write([]byte(b.String()))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(sig))
}

// maskPhone keeps the last 4 digits for logs (never log full customer numbers).
func maskPhone(p string) string {
	if len(p) <= 4 {
		return "****"
	}
	return "***" + p[len(p)-4:]
}
