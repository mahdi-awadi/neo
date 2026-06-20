package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mahdi-awadi/gopkg/communication/provider"
)

type recSender struct{ last *provider.SendRequest }

func (s *recSender) Send(_ context.Context, r *provider.SendRequest) (*provider.SendResponse, error) {
	s.last = r
	return &provider.SendResponse{Success: true}, nil
}

func TestHandleSendRelaysApprovedReply(t *testing.T) {
	s := &recSender{}
	gw := &gateway{neoSecret: "n", sender: s}
	body := []byte(`{"to":"cust@example.com","subject":"Re: hi","text":"Thanks!","inReplyTo":"<m1>"}`)
	req := httptest.NewRequest(http.MethodPost, "/send", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer n")
	rec := httptest.NewRecorder()
	gw.handleSend(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if s.last == nil || s.last.RecipientEmail != "cust@example.com" || s.last.Body != "Thanks!" {
		t.Fatalf("send wrong: %+v", s.last)
	}
}

func TestHandleSendRejectsBadSecret(t *testing.T) {
	gw := &gateway{neoSecret: "n"}
	req := httptest.NewRequest(http.MethodPost, "/send", bytes.NewReader([]byte(`{"to":"x@y.com","text":"hi"}`)))
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	gw.handleSend(rec, req)
	if rec.Code != 401 {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}
