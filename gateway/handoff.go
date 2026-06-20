package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// handoffMsg is a conversation summary the Gemini front-desk hands to the operator.
type handoffMsg struct {
	Channel  string // "whatsapp" (later "voice")
	From     string // customer phone
	FromName string // WhatsApp profile name, if any
	Intent   string // "quote" | "support" | "other"
	Summary  string // the AI's summary of what the customer wants / their issue
}

// handoffFunc posts a conversation summary to Neo's inbox for the operator to follow up. PLAIN
// DATA — like the email inbox path, it is just stored and shown to the operator (no auto-reply).
type handoffFunc func(ctx context.Context, h handoffMsg) error

// intentSubject maps an intent to the inbox subject line the operator sees.
func intentSubject(intent string) string {
	switch intent {
	case "quote":
		return "WhatsApp · Quote request"
	case "support":
		return "WhatsApp · Support issue"
	default:
		return "WhatsApp · New message"
	}
}

// neoHandoff posts the summary to Neo's /inbox endpoint (same endpoint + secret as the email inbox
// path), tagged with the channel so it surfaces in the operator's Telegram /inbox and web console.
func neoHandoff(url, secret string, hc *http.Client) handoffFunc {
	return func(ctx context.Context, h handoffMsg) error {
		channel := h.Channel
		if channel == "" {
			channel = "whatsapp"
		}
		raw, err := json.Marshal(map[string]string{
			"channel": channel, "from": h.From, "fromName": h.FromName,
			"subject": intentSubject(h.Intent), "text": h.Summary,
		})
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+secret)
		req.Header.Set("Content-Type", "application/json")
		resp, err := hc.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("neo handoff: status %d", resp.StatusCode)
		}
		return nil
	}
}
