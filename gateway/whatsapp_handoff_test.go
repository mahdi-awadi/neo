package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mahdi-awadi/gopkg/ai/llm"
)

func TestIntentSubject(t *testing.T) {
	cases := map[string]string{"quote": "WhatsApp · Quote request", "support": "WhatsApp · Support issue", "weird": "WhatsApp · New message", "": "WhatsApp · New message"}
	for in, want := range cases {
		if got := intentSubject(in); got != want {
			t.Fatalf("intentSubject(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNeoHandoffPostsSummaryToInbox(t *testing.T) {
	var gotAuth string
	var body map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	h := neoHandoff(srv.URL, "sek", srv.Client())
	err := h(context.Background(), handoffMsg{Channel: "whatsapp", From: "+15551234567", FromName: "Ann", Intent: "quote", Summary: "Wants a quote for a 5-page site, ~2 weeks, budget $3k."})
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer sek" {
		t.Fatalf("auth = %q", gotAuth)
	}
	if body["channel"] != "whatsapp" || body["from"] != "+15551234567" || body["fromName"] != "Ann" {
		t.Fatalf("inbox payload identity wrong: %+v", body)
	}
	if body["subject"] != "WhatsApp · Quote request" {
		t.Fatalf("subject = %q", body["subject"])
	}
	if body["text"] == "" || body["text"][:5] != "Wants" {
		t.Fatalf("text = %q", body["text"])
	}
}

func TestNeoHandoffNon200IsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) }))
	defer srv.Close()
	if err := neoHandoff(srv.URL, "s", srv.Client())(context.Background(), handoffMsg{From: "+1", Summary: "x"}); err == nil {
		t.Fatal("want error on non-200")
	}
}

func TestWhatsAppDispatcherRoutesHandoffAndCompany(t *testing.T) {
	var got handoffMsg
	var gotBrief string
	disp := whatsappDispatcher(
		ingressFunc(func(_ context.Context, brief string) (string, error) { gotBrief = brief; return "in stock", nil }),
		handoffFunc(func(_ context.Context, h handoffMsg) error { got = h; return nil }),
		"+15551234567", "Ann",
	)

	// handoff_to_operator → posts a summary for this customer
	if _, err := disp(context.Background(), llm.ToolCall{Name: "handoff_to_operator", Args: map[string]any{"intent": "support", "summary": "Login broken on order #7"}}); err != nil {
		t.Fatal(err)
	}
	if got.From != "+15551234567" || got.FromName != "Ann" || got.Intent != "support" || got.Summary != "Login broken on order #7" {
		t.Fatalf("handoff = %+v", got)
	}

	// dispatch_to_company → calls the ingress
	out, err := disp(context.Background(), llm.ToolCall{Name: "dispatch_to_company", Args: map[string]any{"brief": "is product X in stock?"}})
	if err != nil || out != "in stock" || gotBrief != "is product X in stock?" {
		t.Fatalf("dispatch out=%v brief=%q err=%v", out, gotBrief, err)
	}
}

func TestWhatsAppDispatcherRejectsEmptyAndUnknown(t *testing.T) {
	disp := whatsappDispatcher(
		ingressFunc(func(_ context.Context, _ string) (string, error) { return "", nil }),
		handoffFunc(func(_ context.Context, _ handoffMsg) error { return nil }),
		"+1", "",
	)
	if _, err := disp(context.Background(), llm.ToolCall{Name: "handoff_to_operator", Args: map[string]any{"intent": "quote", "summary": ""}}); err == nil {
		t.Fatal("empty summary must error")
	}
	if _, err := disp(context.Background(), llm.ToolCall{Name: "nope", Args: map[string]any{}}); err == nil {
		t.Fatal("unknown tool must error")
	}
}
