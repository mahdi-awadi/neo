package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/mahdi-awadi/gopkg/communication/email/cloudflare"
)

// inboxFunc forwards a received customer message to Neo's inbox (PLAIN DATA — no AI).
type inboxFunc func(ctx context.Context, in cloudflare.Inbound) error

// neoInbox posts a received message to Neo's /inbox endpoint, where it's stored and shown to the
// operator for review. No Gemini, no company, no reply — just hand off the data.
func neoInbox(url, secret string, hc *http.Client) inboxFunc {
	return func(ctx context.Context, in cloudflare.Inbound) error {
		raw, err := json.Marshal(map[string]string{
			"channel": "email", "from": in.From, "fromName": in.FromName, "to": in.To,
			"subject": in.Subject, "text": in.Text, "html": in.HTML, "messageId": in.MessageID,
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
			return fmt.Errorf("neo inbox: status %d", resp.StatusCode)
		}
		return nil
	}
}

// ingressFunc dispatches a brief to the Neo company and returns its result text.
type ingressFunc func(ctx context.Context, brief string) (string, error)

// neoIngress posts a brief to the Neo /agent/ingress endpoint.
func neoIngress(url, secret string, hc *http.Client) ingressFunc {
	return func(ctx context.Context, brief string) (string, error) {
		raw, err := json.Marshal(map[string]string{"brief": brief})
		if err != nil {
			return "", err
		}
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
