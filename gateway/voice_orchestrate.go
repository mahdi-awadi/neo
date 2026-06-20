package main

import (
	"context"
	"fmt"

	"github.com/mahdi-awadi/gopkg/voice/pipeline"
	"github.com/mahdi-awadi/gopkg/voice/toolexec"
)

// voiceSystemPrompt is the spoken counterpart of the WhatsApp front-desk: same intent triage, but
// concise for voice. The AI talks to the caller, gathers what the team needs, and hands a summary
// to the operator — it never quotes or resolves on the call.
const voiceSystemPrompt = `You are the voice assistant answering calls for the business. Keep the call as SHORT as possible:
find out what the caller needs, collect only the minimum the team requires, hand off, and let them
go. Speak in short, natural sentences — no chit-chat.

- Catch the intent in the first exchange. If they've already said enough, hand off right away.
- QUOTE / SALES: ask only for the essentials the team needs (what they want, rough scope, timeline,
  budget, a callback number) — group them so you ask as few times as possible. As soon as you have
  enough, call handoff_to_operator(intent="quote", summary=...) and say the team will call back with
  a quote.
- SUPPORT: capture the issue and any order/account reference, then call
  handoff_to_operator(intent="support", summary=...) and say the team will contact them shortly.
- A simple question: answer in one sentence. A real lookup or action: dispatch_to_company.

Never promise prices, deadlines, or actions you haven't confirmed. Once you've handed off, wrap up
and end the call politely.`

// voiceTools declares the two front-desk tools in the voice pipeline's schema type (mirrors the
// WhatsApp tools — same names/semantics, different declaration type).
func voiceTools() []pipeline.ToolDecl {
	return []pipeline.ToolDecl{
		{
			Name:        "dispatch_to_company",
			Description: "Hand a self-contained work brief to the company (the operator's back office) and get its result. Use for anything needing real work, a lookup, or an action. The company sees only your brief, not the call.",
			Parameters: pipeline.ToolSchema{
				Type:     "object",
				Required: []string{"brief"},
				Properties: map[string]pipeline.ToolProperty{
					"brief": {Type: "string", Description: "a clear, self-contained brief for the company to execute"},
				},
			},
		},
		{
			Name:        "handoff_to_operator",
			Description: "Record a summary of this call for the operator (the human team) to follow up. Use for a quote request after gathering the project details, and for a support issue after capturing the problem. Then tell the caller the team will contact them.",
			Parameters: pipeline.ToolSchema{
				Type:     "object",
				Required: []string{"intent", "summary"},
				Properties: map[string]pipeline.ToolProperty{
					"intent":  {Type: "string", Description: "the caller's intent", Enum: []string{"quote", "support", "other"}},
					"summary": {Type: "string", Description: "a clear, self-contained summary of what the caller wants or their issue, with details gathered (scope, timeline, budget, order/account, urgency, callback)"},
				},
			},
		},
	}
}

// voiceToolFunc routes Gemini-Live tool calls during a call: dispatch_to_company → Neo ingress;
// handoff_to_operator → post a summary to the Neo inbox (channel="voice"), attributed to this caller.
func voiceToolFunc(ingress ingressFunc, handoff handoffFunc, from string) toolexec.Func {
	return func(ctx context.Context, call pipeline.ToolCall, _ pipeline.Session) (any, error) {
		switch call.Name {
		case "dispatch_to_company":
			brief, _ := call.Args["brief"].(string)
			if brief == "" {
				return nil, fmt.Errorf("dispatch_to_company: empty brief")
			}
			return ingress(ctx, brief)
		case "handoff_to_operator":
			summary, _ := call.Args["summary"].(string)
			if summary == "" {
				return nil, fmt.Errorf("handoff_to_operator: empty summary")
			}
			intent, _ := call.Args["intent"].(string)
			if err := handoff(ctx, handoffMsg{Channel: "voice", From: from, Intent: intent, Summary: summary}); err != nil {
				return nil, err
			}
			return "Logged for the operator. Tell the caller the team will follow up.", nil
		default:
			return nil, fmt.Errorf("unknown tool %q", call.Name)
		}
	}
}
