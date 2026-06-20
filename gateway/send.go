package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/mahdi-awadi/gopkg/communication/provider"
)

// handleSend: Neo (operator-approved) asks the gateway to email a reply to a customer. The gateway
// relays it via the Cloudflare Worker. Authed with the Neo↔gateway shared secret. This is the ONLY
// outbound path — nothing is sent without an operator-approved call here.
func (g *gateway) handleSend(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+g.neoSecret {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var b struct {
		To        string `json:"to"`
		Subject   string `json:"subject"`
		Text      string `json:"text"`
		HTML      string `json:"html"`
		InReplyTo string `json:"inReplyTo"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.To == "" || (b.Text == "" && b.HTML == "") {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	opts := map[string]any{}
	if b.InReplyTo != "" {
		opts["headers"] = map[string]string{"In-Reply-To": b.InReplyTo, "References": b.InReplyTo}
	}
	if _, err := g.sender.Send(r.Context(), &provider.SendRequest{
		RecipientEmail: b.To, Subject: b.Subject, Body: b.Text, HTMLBody: b.HTML, Options: opts,
	}); err != nil {
		log.Printf("send: failed to %s: %v", b.To, err)
		http.Error(w, "send failed", http.StatusBadGateway)
		return
	}
	log.Printf("send: replied to %s (operator-approved)", b.To)
	w.WriteHeader(http.StatusOK)
}
