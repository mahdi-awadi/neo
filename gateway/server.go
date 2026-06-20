package main

import "net/http"

func (g *gateway) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /inbound/email", g.handleInbound)
	mux.HandleFunc("POST /inbound/whatsapp", g.handleInboundWhatsApp)
	mux.HandleFunc("POST /voice/incoming", g.handleVoiceIncoming) // Twilio Voice webhook → TwiML <Stream>
	mux.HandleFunc("/voice/stream", g.handleVoiceStream)          // Twilio Media Streams WebSocket (same subdomain)
	mux.HandleFunc("POST /send", g.handleSend)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	return mux
}
