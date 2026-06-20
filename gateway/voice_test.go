package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/mahdi-awadi/gopkg/voice/pipeline"
)

func TestWssStreamURL(t *testing.T) {
	cases := map[string]string{
		"https://neo-api.tech-gate.online":  "wss://neo-api.tech-gate.online/voice/stream",
		"https://neo-api.tech-gate.online/": "wss://neo-api.tech-gate.online/voice/stream",
		"http://172.20.0.1:8080":            "ws://172.20.0.1:8080/voice/stream",
	}
	for in, want := range cases {
		if got := wssStreamURL(in); got != want {
			t.Fatalf("wssStreamURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestVoiceTwiMLConnectsStreamOnSameSubdomain(t *testing.T) {
	xml := voiceTwiML("wss://neo-api.tech-gate.online/voice/stream", "+15551234567")
	for _, want := range []string{
		`<Connect>`,
		`<Stream url="wss://neo-api.tech-gate.online/voice/stream">`,
		`<Parameter name="from" value="+15551234567"/>`,
	} {
		if !strings.Contains(xml, want) {
			t.Fatalf("TwiML missing %q:\n%s", want, xml)
		}
	}
	// the caller id is XML-attribute-escaped
	if !strings.Contains(voiceTwiML("wss://x/voice/stream", `a"&b`), `a&quot;&amp;b`) {
		t.Fatal("TwiML did not escape the from value")
	}
}

func TestReadTwilioStartExtractsStreamSidAndFrom(t *testing.T) {
	// Server side: upgrade, then send Twilio's "connected" then "start" frames (start carries the
	// streamSid and the <Parameter> custom params), exactly as Twilio Media Streams does.
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		_ = c.WriteMessage(websocket.TextMessage, []byte(`{"event":"connected","protocol":"Call","version":"1.0.0"}`))
		_ = c.WriteMessage(websocket.TextMessage, []byte(`{"event":"start","start":{"streamSid":"MZ123","callSid":"CA1","customParameters":{"from":"whatsapp:+15551234567"}}}`))
		// hold the connection open briefly so the client can read both frames
		_, _, _ = c.ReadMessage()
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	streamSid, from, err := readTwilioStart(conn)
	if err != nil {
		t.Fatal(err)
	}
	if streamSid != "MZ123" || from != "whatsapp:+15551234567" {
		t.Fatalf("readTwilioStart = (%q, %q)", streamSid, from)
	}
}

func TestVoiceToolFuncRoutesHandoffAndCompany(t *testing.T) {
	var got handoffMsg
	var gotBrief string
	fn := voiceToolFunc(
		ingressFunc(func(_ context.Context, brief string) (string, error) { gotBrief = brief; return "in stock", nil }),
		handoffFunc(func(_ context.Context, h handoffMsg) error { got = h; return nil }),
		"+15551234567",
	)

	if _, err := fn(context.Background(), pipeline.ToolCall{Name: "handoff_to_operator", Args: map[string]any{"intent": "quote", "summary": "wants a 5-page site"}}, pipeline.Session{}); err != nil {
		t.Fatal(err)
	}
	if got.Channel != "voice" || got.From != "+15551234567" || got.Intent != "quote" || got.Summary != "wants a 5-page site" {
		t.Fatalf("handoff = %+v", got)
	}

	out, err := fn(context.Background(), pipeline.ToolCall{Name: "dispatch_to_company", Args: map[string]any{"brief": "stock of X?"}}, pipeline.Session{})
	if err != nil || out != "in stock" || gotBrief != "stock of X?" {
		t.Fatalf("dispatch out=%v brief=%q err=%v", out, gotBrief, err)
	}

	if _, err := fn(context.Background(), pipeline.ToolCall{Name: "handoff_to_operator", Args: map[string]any{"summary": ""}}, pipeline.Session{}); err == nil {
		t.Fatal("empty summary must error")
	}
	if _, err := fn(context.Background(), pipeline.ToolCall{Name: "nope"}, pipeline.Session{}); err == nil {
		t.Fatal("unknown tool must error")
	}
}
