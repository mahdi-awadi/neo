package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mahdi-awadi/gopkg/communication/email/cloudflare"
)

func TestHandleInboundForwardsToInbox(t *testing.T) {
	var got cloudflare.Inbound
	gw := &gateway{
		gatewaySecret: "s",
		inboxFn: func(_ context.Context, in cloudflare.Inbound) error {
			got = in
			return nil
		},
	}

	body := []byte(`{"from":"cust@example.com","fromName":"Cust","subject":"hi","text":"where is my order","messageId":"<m1>"}`)
	req := httptest.NewRequest(http.MethodPost, "/inbound/email", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer s")
	rec := httptest.NewRecorder()
	gw.handleInbound(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if got.From != "cust@example.com" || got.Subject != "hi" || got.Text != "where is my order" {
		t.Fatalf("inbox got wrong message: %+v", got)
	}
}

func TestHandleInboundRejectsBadSecret(t *testing.T) {
	gw := &gateway{gatewaySecret: "s"}
	req := httptest.NewRequest(http.MethodPost, "/inbound/email", bytes.NewReader([]byte(`{}`)))
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	gw.handleInbound(rec, req)
	if rec.Code != 401 {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}
