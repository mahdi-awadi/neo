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
	gw := &gateway{sender: sender, store: newMemCache(), gatewaySecret: "s", replyFn: reply, fromEmail: "support@tech-gate.online"}

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
	gw := &gateway{gatewaySecret: "s", store: newMemCache()}
	req := httptest.NewRequest(http.MethodPost, "/inbound/email", bytes.NewReader([]byte(`{}`)))
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	gw.handleInbound(rec, req)
	if rec.Code != 401 {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}
