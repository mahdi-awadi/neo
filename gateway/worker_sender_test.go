package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mahdi-awadi/gopkg/communication/provider"
)

func TestWorkerSenderPostsToWorker(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"messageId":"m-123"}`))
	}))
	defer srv.Close()

	s := newWorkerSender(srv.URL, "shh", "support@tech-gate.online", "Support", srv.Client())
	resp, err := s.Send(context.Background(), &provider.SendRequest{RecipientEmail: "c@e.com", Subject: "Re: hi", Body: "hello", HTMLBody: "<p>hello</p>"})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !resp.Success || resp.ProviderMessageID != "m-123" {
		t.Fatalf("resp: %+v", resp)
	}
	if gotAuth != "Bearer shh" {
		t.Fatalf("auth: %s", gotAuth)
	}
	if gotBody["to"] != "c@e.com" || gotBody["from"] != "Support <support@tech-gate.online>" || gotBody["subject"] != "Re: hi" {
		t.Fatalf("body: %v", gotBody)
	}
}

func TestWorkerSenderErrorsOnNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer srv.Close()
	s := newWorkerSender(srv.URL, "shh", "f@x.com", "", srv.Client())
	if _, err := s.Send(context.Background(), &provider.SendRequest{RecipientEmail: "c@e.com", Subject: "s", Body: "b"}); err == nil {
		t.Fatal("expected error on 500")
	}
}
