package main

import "net/http"

func (g *gateway) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /inbound/email", g.handleInbound)
	mux.HandleFunc("POST /send", g.handleSend)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	return mux
}
