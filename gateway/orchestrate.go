package main

import (
	"context"
	"fmt"

	"github.com/mahdi-awadi/gopkg/ai/llm"
	"github.com/mahdi-awadi/gopkg/ai/orchestrator"
)

// companyTool is the single tool exposed to Gemini.
var companyTool = llm.ToolDecl{
	Name:        "dispatch_to_company",
	Description: "Hand a self-contained work brief to the company (the operator's back office) and get its result. Use for anything that needs real work, lookups, or action beyond what you can answer directly. The company does not see the customer's message — only your brief — so write a clear, complete brief.",
	Parameters: llm.ToolSchema{
		Type:     "object",
		Required: []string{"brief"},
		Properties: map[string]llm.ToolProperty{
			"brief": {Type: "string", Description: "a clear, self-contained brief/prompt for the company to execute"},
		},
	},
}

// companyDispatcher turns the model's tool call into a Neo ingress call.
func companyDispatcher(ingress ingressFunc) orchestrator.ToolDispatcher {
	return func(ctx context.Context, call llm.ToolCall) (any, error) {
		brief, _ := call.Args["brief"].(string)
		if brief == "" {
			return nil, fmt.Errorf("dispatch_to_company: empty brief")
		}
		return ingress(ctx, brief)
	}
}

const systemPrompt = `You are the customer support agent for the business. Be warm, concise, and helpful.
Answer simple questions directly. For anything needing real work, a lookup, or an action, call
dispatch_to_company with a clear self-contained brief and use its result to write your reply.
Never promise actions you haven't confirmed via the tool.`

// replyForInbound runs one Gemini pass over the inbound text and returns the assistant reply.
func replyForInbound(ctx context.Context, reg *llm.Registry, ingress ingressFunc, history []conversationMessage, userText string) (string, error) {
	res, err := orchestrator.Process(ctx, reg, orchestrator.Config{
		SystemPrompt: systemPrompt,
		Tools:        []llm.ToolDecl{companyTool},
		History:      toConvHistory(history),
		MaxToolHops:  4,
		Dispatcher:   companyDispatcher(ingress),
	}, userText)
	if err != nil {
		return "", err
	}
	return res.AssistantText, nil
}
