package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/mahdi-awadi/gopkg/communication/provider"
)

// workerSender sends outbound email by POSTing to the Cloudflare Email Worker's /send (fetch)
// handler, which calls env.EMAIL.send(). This keeps all Cloudflare credentials out of the container.
type workerSender struct {
	url       string
	secret    string
	fromEmail string
	fromName  string
	http      *http.Client
}

func newWorkerSender(url, secret, fromEmail, fromName string, hc *http.Client) *workerSender {
	if hc == nil {
		hc = http.DefaultClient
	}
	return &workerSender{url: url, secret: secret, fromEmail: fromEmail, fromName: fromName, http: hc}
}

func (s *workerSender) from() string {
	if s.fromName != "" {
		return fmt.Sprintf("%s <%s>", s.fromName, s.fromEmail)
	}
	return s.fromEmail
}

func (s *workerSender) Send(ctx context.Context, req *provider.SendRequest) (*provider.SendResponse, error) {
	if req.RecipientEmail == "" {
		return nil, fmt.Errorf("workerSender: RecipientEmail required")
	}
	body, mErr := json.Marshal(map[string]any{
		"to":      req.RecipientEmail,
		"from":    s.from(),
		"subject": req.Subject,
		"text":    req.Body,
		"html":    req.HTMLBody,
	})
	if mErr != nil {
		return nil, mErr
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+s.secret)
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := s.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("workerSender: send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("workerSender: worker returned %d", resp.StatusCode)
	}
	var out struct {
		MessageID string `json:"messageId"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return &provider.SendResponse{Success: true, ProviderCode: "cloudflare-worker", ProviderMessageID: out.MessageID}, nil
}
