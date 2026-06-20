package main

import (
	"context"
	"testing"

	"github.com/mahdi-awadi/gopkg/ai/conversation"
	"github.com/mahdi-awadi/gopkg/ai/llm"
)

func TestMemCacheAppendRecent(t *testing.T) {
	c := newMemCache()
	ctx := context.Background()
	_ = c.Append(ctx, "k", conversation.Message{Role: "user", Content: "hi"})
	_ = c.Append(ctx, "k", conversation.Message{Role: "model", Content: "hello"})
	got, _ := c.Recent(ctx, "k", 10)
	if len(got) != 2 || got[1].Content != "hello" {
		t.Fatalf("recent = %+v", got)
	}
}

func TestCompanyToolDispatcherCallsIngress(t *testing.T) {
	var gotBrief string
	disp := companyDispatcher(ingressFunc(func(_ context.Context, brief string) (string, error) {
		gotBrief = brief
		return "order ships tomorrow", nil
	}))
	out, err := disp(context.Background(), llm.ToolCall{Name: "dispatch_to_company", Args: map[string]any{"brief": "find order #7"}})
	if err != nil {
		t.Fatal(err)
	}
	if gotBrief != "find order #7" || out != "order ships tomorrow" {
		t.Fatalf("brief=%q out=%v", gotBrief, out)
	}
}
