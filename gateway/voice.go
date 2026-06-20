package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	holdfiller "github.com/mahdi-awadi/gopkg/voice/holdfiller/twilio"
	"github.com/mahdi-awadi/gopkg/voice/llm/gemini"
	"github.com/mahdi-awadi/gopkg/voice/pipeline"
	"github.com/mahdi-awadi/gopkg/voice/toolexec"
	twiliotransport "github.com/mahdi-awadi/gopkg/voice/transport/twilio"
)

// voiceUpgrader upgrades Twilio's Media Streams HTTP request to a WebSocket. Twilio sends no Origin
// header, so origin checks don't apply; the X-Twilio-Signature on the preceding /voice/incoming
// webhook is the auth gate that decides whether a stream is opened at all.
var voiceUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(*http.Request) bool { return true },
}

// handleVoiceIncoming is the Twilio Voice webhook: it answers a call with TwiML that connects the
// call's audio to our WebSocket (/voice/stream) on the SAME gateway subdomain. The caller's number
// is passed through as a <Stream> <Parameter> so the stream handler can attribute the handoff.
func (g *gateway) handleVoiceIncoming(w http.ResponseWriter, r *http.Request) {
	if g.twilioAuthToken == "" {
		http.Error(w, "voice not configured", http.StatusServiceUnavailable)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	if !twilioSignatureValid(g.twilioAuthToken, g.publicURL+"/voice/incoming", r.PostForm, r.Header.Get("X-Twilio-Signature")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	from := r.PostForm.Get("From")
	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	_, _ = w.Write([]byte(voiceTwiML(wssStreamURL(g.publicURL), from)))
}

// wssStreamURL derives the WebSocket stream URL on the same subdomain as the gateway's public URL.
func wssStreamURL(publicURL string) string {
	u := strings.TrimSuffix(publicURL, "/")
	if strings.HasPrefix(u, "https://") {
		u = "wss://" + strings.TrimPrefix(u, "https://")
	} else if strings.HasPrefix(u, "http://") {
		u = "ws://" + strings.TrimPrefix(u, "http://")
	}
	return u + "/voice/stream"
}

// voiceTwiML returns the <Connect><Stream> TwiML pointing Twilio at our WebSocket.
func voiceTwiML(streamURL, from string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>` +
		`<Response><Connect><Stream url="` + xmlEscape(streamURL) + `">` +
		`<Parameter name="from" value="` + xmlEscape(from) + `"/>` +
		`</Stream></Connect></Response>`
}

func xmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")
	return r.Replace(s)
}

// handleVoiceStream bridges the Twilio Media Streams WebSocket to Gemini Live for one call. Gemini
// runs the same front-desk triage (voiceSystemPrompt + voiceTools); a hold-filler keeps the line
// alive while the company works. The bridge runs until the caller hangs up or a fatal error.
func (g *gateway) handleVoiceStream(w http.ResponseWriter, r *http.Request) {
	if g.geminiAPIKey == "" {
		http.Error(w, "voice not configured", http.StatusServiceUnavailable)
		return
	}
	conn, err := voiceUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the error response
	}
	defer conn.Close()

	// Consume Twilio's pre-stream "connected"/"start" handshake to learn the StreamSid (required on
	// every outbound frame) and the caller's number (passed as a <Parameter>).
	streamSid, from, err := readTwilioStart(conn)
	if err != nil {
		log.Printf("voice: no start frame: %v", err)
		return
	}
	// WhatsApp Calling arrives on the same Twilio Voice path with a "whatsapp:" prefix; strip it so
	// the handoff records a clean phone number (both PSTN and WhatsApp voice share this bridge).
	from = strings.TrimPrefix(from, "whatsapp:")

	// The pipeline lifetime is the call, not the HTTP request (the conn is hijacked on upgrade).
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	gconn, err := dialGeminiLive(ctx, g.geminiLiveURL, g.geminiAPIKey)
	if err != nil {
		log.Printf("voice: gemini dial failed for %s: %v", maskPhone(from), err)
		return
	}
	defer gconn.Close()

	p, err := pipeline.New(pipeline.Options{Filler: holdfiller.New()})
	if err != nil {
		log.Printf("voice: pipeline init: %v", err)
		return
	}
	transport := twiliotransport.NewTransport(conn, streamSid)
	llm := gemini.NewLLM(gconn)
	exec := toolexec.New(voiceToolFunc(g.ingressFn, g.handoffFn, from))
	setup := pipeline.SetupRequest{SystemPrompt: voiceSystemPrompt, Tools: voiceTools()}

	log.Printf("voice: call started from %s (stream %s)", maskPhone(from), streamSid)
	if err := p.Run(ctx, transport, llm, exec, setup, map[string]string{"from": from}); err != nil {
		log.Printf("voice: call ended with error for %s: %v", maskPhone(from), err)
		return
	}
	log.Printf("voice: call ended from %s", maskPhone(from))
}

// readTwilioStart reads inbound WS messages until Twilio's "start" event, returning the StreamSid
// and the caller's number (from the <Stream> custom parameter "from"). Subsequent "media" frames
// are read by the transport's Receive.
func readTwilioStart(conn *websocket.Conn) (streamSid, from string, err error) {
	for {
		_, raw, rerr := conn.ReadMessage()
		if rerr != nil {
			return "", "", rerr
		}
		var m twiliotransport.TwilioMessage
		if json.Unmarshal(raw, &m) != nil {
			continue // skip malformed/handshake-only frames
		}
		if m.Event == "start" && m.Start != nil {
			return m.Start.StreamSid, m.Start.CustomParameters["from"], nil
		}
	}
}

// dialGeminiLive opens the Gemini Live WebSocket (v1beta BidiGenerateContent by default). The API
// key rides in the query string — never log the raw URL. Mirrors the proven saffar/eticket dial.
func dialGeminiLive(ctx context.Context, baseURL, apiKey string) (*websocket.Conn, error) {
	if baseURL == "" {
		baseURL = gemini.LiveEndpoint
	}
	u := baseURL + "?key=" + url.QueryEscape(apiKey)
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	hdr := http.Header{}
	hdr.Set("Content-Type", "application/json")
	conn, _, err := dialer.DialContext(ctx, u, hdr)
	return conn, err
}
