import { expect, test } from 'bun:test';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { startCodexMcpBridge } from '../src/engine/codex-mcp-bridge';

test('only the per-run capability permits MCP initialization, and closing revokes access', async () => {
  const server = createSdkMcpServer({ name: 'neo', version: '1', tools: [tool('probe', 'probe', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }))] });
  const bridge = await startCodexMcpBridge(server, ['probe']);
  const cfg = bridge.codexConfig.mcp_servers.neo;
  const request = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) };
  expect((await fetch(cfg.url, request)).status).toBe(401);
  expect((await fetch(cfg.url, { ...request, headers: { ...request.headers, authorization: `Bearer ${bridge.env[cfg.bearer_token_env_var]}` } })).status).toBe(200);
  expect(cfg.tools.probe.approval_mode).toBe('approve');
  await bridge.close();
  await bridge.close();
  await expect(fetch(cfg.url, request)).rejects.toThrow();
});

test('authenticated tools stay bound to one bridge and cannot be called with another capability', async () => {
  let calls = 0;
  const make = () => createSdkMcpServer({ name: 'neo', version: '1', tools: [tool('probe', 'probe', {}, async () => { calls++; return { content: [{ type: 'text', text: 'ok' }] }; })] });
  const a = await startCodexMcpBridge(make(), ['probe']);
  const b = await startCodexMcpBridge(make(), ['probe']);
  try {
    const cfg = a.codexConfig.mcp_servers.neo;
    const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const wrong = await fetch(cfg.url, { method: 'POST', headers: { ...base, authorization: `Bearer ${b.env[cfg.bearer_token_env_var]}` }, body: init });
    expect(wrong.status).toBe(401);
    const headers = { ...base, authorization: `Bearer ${a.env[cfg.bearer_token_env_var]}` };
    const initialized = await fetch(cfg.url, { method: 'POST', headers, body: init });
    const session = initialized.headers.get('mcp-session-id');
    expect(session).toBeTruthy();
    const call = await fetch(cfg.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': session! }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'probe', arguments: {} } }) });
    expect(call.status).toBe(200);
    expect(await call.json()).toMatchObject({ result: { content: [{ text: 'ok' }] } });
    expect(calls).toBe(1);
  } finally {
    await a.close(); await b.close();
  }
});

test('Codex worker receives the scoped server and closes it after the turn', async () => {
  const { runOrder } = await import('../src/engine/session-runner');
  const bridge = await import('../src/engine/codex-mcp-bridge');
  const server = createSdkMcpServer({ name: 'neo', version: '1', tools: [tool('probe', 'probe', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }))] });
  bridge.registerCodexMcpTools(server, ['probe']);
  let cfg: any;
  const result = await runOrder({ id: 'probe', source: 'neo', folder: '/tmp', task: 'probe', chatId: 1, createdAt: Date.now() }, { onMessage: () => {}, onEscalation: async () => 'deny' }, {
    provider: 'codex', mcpServers: { neo: server },
    codexFactory: async (options) => { cfg = options; return { startThread: () => ({ id: null, runStreamed: async () => ({ events: (async function* () { yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }; })() }) }), resumeThread: () => { throw new Error('unexpected'); } } as never; },
  });
  expect(result.ok).toBe(true);
  expect(cfg.config.mcp_servers.neo.tools.probe.approval_mode).toBe('approve');
  const tokenVar = cfg.config.mcp_servers.neo.bearer_token_env_var;
  expect(cfg.env[tokenVar]).toBeTruthy();
  await expect(fetch(cfg.config.mcp_servers.neo.url)).rejects.toThrow();
});

test('unrelated configured MCP servers are explicitly disabled for a Codex run', async () => {
  const mod = await import('../src/engine/codex-mcp-bridge');
  expect(typeof (mod as any).codexMcpDisableOverrides).toBe('function');
  const disabled = (mod as any).codexMcpDisableOverrides([{ name: 'foreign', type: 'stdio' }, { name: 'foreign_http', type: 'streamable_http' }], ['neo']);
  expect(disabled['mcp_servers.foreign.enabled']).toBe(false);
  expect(disabled['mcp_servers.foreign.command']).toBe('false');
  expect(disabled['mcp_servers.foreign_http.url']).toBe('http://127.0.0.1');
  expect(disabled['mcp_servers.foreign_http.enabled']).toBe(false);
  expect(() => (mod as any).codexMcpDisableOverrides([{ name: 'neo', type: 'stdio' }], ['neo'])).toThrow();
  expect(() => (mod as any).codexMcpDisableOverrides([{ name: 'bad.name', type: 'stdio' }], [])).toThrow();
});

test('MCP discovery fails closed when the Codex command cannot run', async () => {
  const { discoverCodexMcpServers } = await import('../src/engine/codex-mcp-bridge');
  await expect(discoverCodexMcpServers('/nonexistent-neo-codex', '/tmp', process.env)).rejects.toThrow('Cannot safely determine');
});

test('a failed Codex client startup tears down its scoped MCP listener', async () => {
  const { runOrder } = await import('../src/engine/session-runner');
  const { registerCodexMcpTools } = await import('../src/engine/codex-mcp-bridge');
  const server = createSdkMcpServer({ name: 'neo', version: '1', tools: [tool('probe', 'probe', {}, async () => ({ content: [] }))] });
  registerCodexMcpTools(server, ['probe']);
  let url = '';
  await expect(runOrder({ id: 'failed', source: 'neo', folder: '/tmp', task: 'probe', chatId: 1, createdAt: Date.now() }, { onMessage() {}, onEscalation: async () => 'deny' }, {
    provider: 'codex', mcpServers: { neo: server }, codexFactory: async (options) => { url = (options.config as any).mcp_servers.neo.url; throw new Error('startup failed'); },
  })).rejects.toThrow('startup failed');
  await expect(fetch(url)).rejects.toThrow();
});
