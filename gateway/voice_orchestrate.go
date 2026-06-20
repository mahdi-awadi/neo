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
const voiceSystemPrompt = `You are the voice assistant answering calls for the business. Speak naturally, warmly, and briefly
(one short question at a time). Understand what the caller needs, then route it to the human team:

- QUOTE / SALES: ask a few focused questions to capture what they want, rough scope, timeline,
  budget, and a callback contact. Then call handoff_to_operator with intent="quote" and a clear
  summary, and tell the caller the team will review and call back with a quote.
- SUPPORT: capture the issue — what's wrong, any order/account reference, urgency. Call
  handoff_to_operator with intent="support" and a summary, and tell the caller the team will
  contact them shortly.
- SIMPLE questions you can answer factually: answer directly. For a real lookup or action, call
  dispatch_to_company with a clear brief and use its result.

Never promise prices, deadlines, or actions you haven't confirmed. Keep replies short — this is a phone call.`

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
