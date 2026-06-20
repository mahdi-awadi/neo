module github.com/mahdi-awadi/neo-gateway

go 1.23

require (
	github.com/mahdi-awadi/gopkg/ai/conversation v0.1.0
	github.com/mahdi-awadi/gopkg/ai/llm v0.1.0
	github.com/mahdi-awadi/gopkg/ai/llm/geminitext v0.1.0
	github.com/mahdi-awadi/gopkg/ai/orchestrator v0.1.0
	github.com/mahdi-awadi/gopkg/communication/email/cloudflare v0.1.0
	github.com/mahdi-awadi/gopkg/communication/provider v0.1.0
)

replace github.com/mahdi-awadi/gopkg/communication/email/cloudflare => ../../gopkg/communication/email/cloudflare

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/redis/go-redis/v9 v9.18.0 // indirect
	go.uber.org/atomic v1.11.0 // indirect
)
