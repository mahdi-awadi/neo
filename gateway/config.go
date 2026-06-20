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
