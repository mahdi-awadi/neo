// A per-run local transport for Neo's in-process MCP server. The capability never enters argv.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';


const toolNames = new WeakMap<McpSdkServerConfigWithInstance, readonly string[]>();
const serverFactories = new WeakMap<McpSdkServerConfigWithInstance, () => McpSdkServerConfigWithInstance>();
export function registerCodexMcpTools(server: McpSdkServerConfigWithInstance, names: readonly string[], factory?: () => McpSdkServerConfigWithInstance): void {
  toolNames.set(server, [...names]);
  if (factory) serverFactories.set(server, factory);
}
export function registeredCodexMcpTools(server: McpSdkServerConfigWithInstance): readonly string[] | undefined {
  return toolNames.get(server);
}


export async function startCodexMcpBridge(server: McpSdkServerConfigWithInstance, toolNames: readonly string[], name = "neo") {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) throw new Error("Invalid Codex MCP server name");
  const tokenEnv = `NEO_CODEX_MCP_CAPABILITY_${name.toUpperCase()}`;
  const token = randomBytes(32).toString('hex');
  // Every Codex subagent is a separate MCP client. Give it its own SDK server and transport so
  // initialization and simultaneous JSON-RPC request IDs never collide with the parent.
  const sessions = new Map<string, { server: McpSdkServerConfigWithInstance; transport: WebStandardStreamableHTTPServerTransport }>();
  const factory = serverFactories.get(server);
  let firstUsed = false;
  let pending = 0;
  let closed = false;
  let listener: ReturnType<typeof Bun.serve>;
  try {
    listener = Bun.serve({
      // Long-running tool calls and the MCP event stream must not be cut off while idle.
      hostname: '127.0.0.1', port: 0, idleTimeout: 0,
      async fetch(req) {
        const presented = req.headers.get('authorization') ?? '';
        const expected = `Bearer ${token}`;
        const a = Buffer.from(presented), b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return new Response('Unauthorized', { status: 401 });
        const session = req.headers.get('mcp-session-id');
        if (session) {
          const entry = sessions.get(session);
          if (!entry) return new Response('Unknown MCP session', { status: 404 });
          const response = await entry.transport.handleRequest(req);
          if (req.method === 'DELETE' && response.ok) {
            sessions.delete(session);
            await entry.server.instance.close();
          }
          return response;
        }
        let initialize = false;
        if (req.method === 'POST') {
          try { initialize = (await req.clone().json() as { method?: unknown }).method === 'initialize'; } catch { /* invalid request */ }
        }
        if (!initialize) return new Response('MCP session required', { status: 400 });
        if (sessions.size + pending >= 64 || (firstUsed && !factory)) return new Response('MCP session unavailable', { status: 503 });
        const instance = firstUsed ? factory!() : server;
        firstUsed = true;
        pending++;
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
        try {
          await instance.instance.connect(transport);
          const response = await transport.handleRequest(req);
          if (closed) {
            await instance.instance.close();
            return new Response('MCP bridge closed', { status: 503 });
          }
          if (response.ok && transport.sessionId) sessions.set(transport.sessionId, { server: instance, transport });
          else await instance.instance.close();
          return response;
        } catch (error) {
          await instance.instance.close();
          throw error;
        } finally { pending--; }
      },
    });
  } catch (error) {
    await server.instance.close();
    throw error;
  }
  const tools = Object.fromEntries(toolNames.map(name => [name, { approval_mode: 'approve' }]));
  return {
    codexConfig: { mcp_servers: { [name]: { url: `http://127.0.0.1:${listener.port}/mcp`, bearer_token_env_var: tokenEnv, tools } } },
    env: { [tokenEnv]: token } as Record<string, string>,
    async close() {
      if (closed) return;
      closed = true;
      listener.stop(true);
      await Promise.all([...sessions.values()].map((entry) => entry.server.instance.close()));
      sessions.clear();
      if (!firstUsed) await server.instance.close();
    },
  };
}

/** Disable every ambient server unless this run explicitly supplies its own scoped instance. */
export function codexMcpDisableOverrides(servers: readonly { name: string; type: string }[], allowed: readonly string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const { name, type } of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Cannot safely isolate a configured Codex MCP server name');
    if (allowed.includes(name)) throw new Error(`Codex MCP server name ${name} conflicts with a Neo-owned server`);
    // A disabled server still requires a valid transport in Codex's configuration parser.
    out[`mcp_servers.${name}.enabled`] = false;
    if (type === 'stdio') out[`mcp_servers.${name}.command`] = 'false';
    else if (type === 'streamable_http') out[`mcp_servers.${name}.url`] = 'http://127.0.0.1';
    else throw new Error('Cannot safely isolate an unknown Codex MCP transport');
  }
  return out;
}

/** Resolve the same platform binary the Codex SDK uses, so discovery and launch read the same config. */
export function codexBinaryPath(): string {
  const { createRequire } = require('node:module') as typeof import('node:module');
  const { dirname, join } = require('node:path') as typeof import('node:path');
  const targets: Record<string, [string, string]> = {
    'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
    'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
    'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
    'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
    'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
    'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error('Cannot safely discover Codex MCP servers on this platform');
  try {
    const rootRequire = createRequire(import.meta.url);
    const codexRequire = createRequire(rootRequire.resolve('@openai/codex/package.json'));
    const packageFile = codexRequire.resolve(`${target[0]}/package.json`);
    return join(dirname(packageFile), 'vendor', target[1], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  } catch {
    throw new Error('Cannot locate the Codex SDK binary for MCP isolation');
  }
}

/** Read names only; never log the JSON, which can contain credentials in server definitions. */
export async function discoverCodexMcpServers(binary: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Array<{ name: string; type: string }>> {
  const { execFile } = await import('node:child_process');
  const result = await new Promise<string>((resolve, reject) => {
    execFile(binary, ['mcp', 'list', '--json'], { cwd, env, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('Cannot safely determine configured Codex MCP servers'));
      else resolve(stdout);
    });
  });
  try {
    const parsed: unknown = JSON.parse(result);
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item.name !== 'string' || typeof item.transport?.type !== 'string')) throw new Error('invalid');
    return parsed.map((item) => ({ name: item.name as string, type: item.transport.type as string }));
  } catch {
    throw new Error('Cannot safely parse configured Codex MCP servers');
  }
}
