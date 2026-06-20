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

const whatsappSystemPrompt = `You are the customer-facing assistant for the business on WhatsApp. Have a warm, concise,
natural conversation to understand what the customer needs, then route it to the human team:

- QUOTE / SALES (e.g. "I want a quote for a project"): ask a few focused questions to gather what the
  team needs to scope and price it — what they want, scope, timeline, budget, and how to reach them.
  When you have enough, call handoff_to_operator with intent="quote" and a clear summary, then tell
  the customer the team will review and get back to them with a quote.
- SUPPORT: capture the issue — what's wrong, any order/account reference, and urgency. Call
  handoff_to_operator with intent="support" and a summary, then tell the customer the team will
  contact them shortly.
- SIMPLE QUESTIONS you can answer factually: answer directly. If it needs a real lookup or action,
  call dispatch_to_company with a clear brief and use its result.

Never promise prices, deadlines, or actions you haven't confirmed. One question at a time; keep it short.`

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
