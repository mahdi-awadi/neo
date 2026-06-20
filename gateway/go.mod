module github.com/mahdi-awadi/neo-gateway

go 1.23

require (
	github.com/mahdi-awadi/gopkg/ai/conversation v0.1.0
	github.com/mahdi-awadi/gopkg/ai/llm v0.1.0
	github.com/mahdi-awadi/gopkg/ai/llm/geminitext v0.1.0
	github.com/mahdi-awadi/gopkg/ai/orchestrator v0.1.0
	github.com/mahdi-awadi/gopkg/communication/email/cloudflare v0.1.0
	github.com/mahdi-awadi/gopkg/communication/provider v0.1.0
	github.com/mahdi-awadi/gopkg/communication/whatsapp/twilio v0.1.0
	github.com/mahdi-awadi/gopkg/voice/holdfiller/twilio v0.1.0
	github.com/mahdi-awadi/gopkg/voice/llm/gemini v0.1.0
	github.com/mahdi-awadi/gopkg/voice/pipeline v0.1.0
	github.com/mahdi-awadi/gopkg/voice/toolexec v0.1.0
	github.com/mahdi-awadi/gopkg/voice/transport/twilio v0.1.0
	github.com/gorilla/websocket v1.5.3
)

replace github.com/mahdi-awadi/gopkg/communication/email/cloudflare => ../../gopkg/communication/email/cloudflare

replace github.com/mahdi-awadi/gopkg/communication/whatsapp/twilio => ../../gopkg/communication/whatsapp/twilio

replace (
	github.com/mahdi-awadi/gopkg/audio/codec => ../../gopkg/audio/codec
	github.com/mahdi-awadi/gopkg/id => ../../gopkg/id
	github.com/mahdi-awadi/gopkg/voice/holdfiller/twilio => ../../gopkg/voice/holdfiller/twilio
	github.com/mahdi-awadi/gopkg/voice/llm/gemini => ../../gopkg/voice/llm/gemini
	github.com/mahdi-awadi/gopkg/voice/pipeline => ../../gopkg/voice/pipeline
	github.com/mahdi-awadi/gopkg/voice/toolexec => ../../gopkg/voice/toolexec
	github.com/mahdi-awadi/gopkg/voice/transport/twilio => ../../gopkg/voice/transport/twilio
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/redis/go-redis/v9 v9.18.0 // indirect
	go.uber.org/atomic v1.11.0 // indirect
)
