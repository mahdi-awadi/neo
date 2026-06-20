package main

import (
	"context"
	"sync"

	"github.com/mahdi-awadi/gopkg/ai/conversation"
)

// memCache is an in-process conversation.Cache (no Redis for the MVP).
type memCache struct {
	mu sync.Mutex
	m  map[string][]conversation.Message
}

func newMemCache() *memCache { return &memCache{m: map[string][]conversation.Message{}} }

func (c *memCache) Get(_ context.Context, key string) ([]conversation.Message, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]conversation.Message(nil), c.m[key]...), nil
}
func (c *memCache) Append(_ context.Context, key string, msg conversation.Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] = append(c.m[key], msg)
	return nil
}
func (c *memCache) Recent(_ context.Context, key string, n int) ([]conversation.Message, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	all := c.m[key]
	if n > 0 && len(all) > n {
		all = all[len(all)-n:]
	}
	return append([]conversation.Message(nil), all...), nil
}
func (c *memCache) Clear(_ context.Context, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.m, key)
	return nil
}

var _ conversation.Cache = (*memCache)(nil)
