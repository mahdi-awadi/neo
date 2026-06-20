package main

import (
	"context"
	"fmt"

	"github.com/mahdi-awadi/gopkg/ai/llm"
	"github.com/mahdi-awadi/gopkg/ai/orchestrator"
)

// handoffTool lets Gemini hand a conversation summary to the operator (posted to the Neo inbox).
var handoffTool = llm.ToolDecl{
	Name: "handoff_to_operator",
	Description: "Record a summary of this conversation for the operator (the human team) to follow up on. " +
		"Use it for a sales/quote request once you've gathered the project details the team needs to scope it, " +
		"and for a support issue once you've captured the problem. After calling it, tell the customer the team " +
		"will contact them — do NOT promise prices, deadlines, or actions yourself.",
	Parameters: llm.ToolSchema{
		Type:     "object",
		Required: []string{"intent", "summary"},
		Properties: map[string]llm.ToolProperty{
			"intent":  {Type: "string", Description: "the customer's intent: \"quote\", \"support\", or \"other\""},
			"summary": {Type: "string", Description: "a clear, self-contained summary of what the customer wants or their issue, including any details gathered (scope, timeline, budget, order/account, urgency, contact)"},
		},
	},
}

const whatsappSystemPrompt = `You are the WhatsApp assistant for the business. Your goal is to resolve each contact in the
FEWEST messages possible: spot what they need, collect only what the team requires, hand off, and
close. Be brief and direct — no pleasantries or filler.

- Read the FIRST message for intent and details. If they've already given enough, hand off
  immediately without asking anything.
- QUOTE / SALES: in ONE message, ask only for the essentials still missing (what they want, rough
  scope, timeline, budget, and a contact) — bundle them, don't ask one at a time. As soon as you can
  scope it, call handoff_to_operator(intent="quote", summary=...) and say the team will send a quote.
- SUPPORT: capture the issue plus any order/account reference (ask once if missing), then call
  handoff_to_operator(intent="support", summary=...) and say the team will follow up shortly.
- A simple factual question: answer in one short line. A real lookup or action: dispatch_to_company.

Never promise prices, deadlines, or actions you haven't confirmed. Keep every reply to 1-2 short
sentences, and stop once you've handed off.`

// whatsappDispatcher routes Gemini's tool calls: dispatch_to_company → Neo ingress (real work),
// handoff_to_operator → post a summary to the Neo inbox for this customer (closure over phone/name).
func whatsappDispatcher(ingress ingressFunc, handoff handoffFunc, sender, name string) orchestrator.ToolDispatcher {
	return func(ctx context.Context, call llm.ToolCall) (any, error) {
		switch call.Name {
		case companyTool.Name:
			brief, _ := call.Args["brief"].(string)
			if brief == "" {
				return nil, fmt.Errorf("dispatch_to_company: empty brief")
			}
			return ingress(ctx, brief)
		case handoffTool.Name:
			summary, _ := call.Args["summary"].(string)
			if summary == "" {
				return nil, fmt.Errorf("handoff_to_operator: empty summary")
			}
			intent, _ := call.Args["intent"].(string)
			if err := handoff(ctx, handoffMsg{Channel: "whatsapp", From: sender, FromName: name, Intent: intent, Summary: summary}); err != nil {
				return nil, err
			}
			return "Logged for the operator. Tell the customer the team will follow up.", nil
		default:
			return nil, fmt.Errorf("unknown tool %q", call.Name)
		}
	}
}

// replyForWhatsApp runs one Gemini front-desk pass over an inbound WhatsApp message and returns the
// customer-facing reply. Any handoff/dispatch happens as a side-effect via the dispatcher.
func replyForWhatsApp(ctx context.Context, reg *llm.Registry, ingress ingressFunc, handoff handoffFunc, sender, name string, history []conversationMessage, userText string) (string, error) {
	res, err := orchestrator.Process(ctx, reg, orchestrator.Config{
		SystemPrompt: whatsappSystemPrompt,
		Tools:        []llm.ToolDecl{companyTool, handoffTool},
		History:      toConvHistory(history),
		MaxToolHops:  5,
		Dispatcher:   whatsappDispatcher(ingress, handoff, sender, name),
	}, userText)
	if err != nil {
		return "", err
	}
	return res.AssistantText, nil
}
