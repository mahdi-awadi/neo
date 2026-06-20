package main

import (
	"fmt"
	"os"
)

type Config struct {
	ListenAddr          string
	GeminiAPIKey        string
	GeminiModel         string
	EmailFrom           string
	EmailFromName       string
	GatewayWorkerSecret string
	WorkerSendURL       string
	NeoIngressURL       string
	NeoInboxURL         string
	NeoIngressSecret    string

	// WhatsApp (Twilio transport, autonomous Gemini channel). Optional: when unset the gateway
	// still serves email; the /inbound/whatsapp route returns 503 until configured.
	TwilioAccountSID   string
	TwilioAuthToken    string
	TwilioWhatsAppFrom string // "whatsapp:+…" or bare "+…"; the provider adds the prefix
	PublicURL          string // gateway's externally-visible base URL (for webhook signature validation)
	GeminiLiveURL      string // optional override for the Gemini Live dial endpoint (voice)
}

func loadConfig() (Config, error) {
	c := Config{
		ListenAddr:          envOr("LISTEN_ADDR", ":8080"),
		GeminiAPIKey:        os.Getenv("GEMINI_API_KEY"),
		GeminiModel:         envOr("GEMINI_MODEL", "gemini-2.5-flash"),
		EmailFrom:           envOr("EMAIL_FROM", "support@tech-gate.online"),
		EmailFromName:       envOr("EMAIL_FROM_NAME", "Support"),
		GatewayWorkerSecret: os.Getenv("GATEWAY_WORKER_SECRET"),
		WorkerSendURL:       os.Getenv("WORKER_SEND_URL"),
		NeoIngressURL:       os.Getenv("NEO_INGRESS_URL"),
		NeoInboxURL:         os.Getenv("NEO_INBOX_URL"),
		NeoIngressSecret:    os.Getenv("NEO_INGRESS_SECRET"),
		TwilioAccountSID:    os.Getenv("TWILIO_ACCOUNT_SID"),
		TwilioAuthToken:     os.Getenv("TWILIO_AUTH_TOKEN"),
		TwilioWhatsAppFrom:  os.Getenv("TWILIO_WHATSAPP_FROM"),
		PublicURL:           envOr("PUBLIC_URL", "https://neo-api.tech-gate.online"),
		GeminiLiveURL:       os.Getenv("GEMINI_LIVE_URL"), // empty → gemini.LiveEndpoint
	}
	for k, v := range map[string]string{"GEMINI_API_KEY": c.GeminiAPIKey, "GATEWAY_WORKER_SECRET": c.GatewayWorkerSecret, "WORKER_SEND_URL": c.WorkerSendURL, "NEO_INGRESS_URL": c.NeoIngressURL, "NEO_INBOX_URL": c.NeoInboxURL, "NEO_INGRESS_SECRET": c.NeoIngressSecret} {
		if v == "" {
			return Config{}, fmt.Errorf("missing required env %s", k)
		}
	}
	return c, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
