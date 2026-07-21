// The engine's own tiny client for the codebase-memory MCP server + the "ensure indexed" guard
// dispatch runs before a worker starts. The engine has no AI, but it CAN speak MCP: the governor
// denies subagents index_repository/list_projects, so a dispatched worker can never self-index —
// the main/engine side must guarantee the index. Two layers: a thin stdio JSON-RPC adapter (real
// IO, not unit-tested) and makeIndexer (the tested orchestration + a process-lifetime "already
// indexed" cache). Spec: docs/superpowers/specs/2026-07-21-dispatch-mandatory-codebase-memory-design.md
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { NeoConfig } from "../config";

/** A project as codebase-memory's list_projects reports it (only the fields we match on). */
export interface CmProject {
  name: string;
  root_path: string;
}

/** The low-level calls the indexer needs — injectable so the orchestration is testable without a
 *  live MCP server. */
export interface CodebaseMemoryClient {
  listProjects(): Promise<CmProject[]>;
  indexRepository(repoPath: string): Promise<void>;
}

/** What dispatch depends on: ensure `folder` is indexed before the worker runs. */
export interface CodebaseMemoryIndexer {
  /** Resolves once `folder` is known-indexed (indexing it first if missing). Best-effort: NEVER
   *  throws — on any failure it logs and resolves, so a dispatch is never blocked by indexing.
   *  `onFirstIndex` fires only when THIS call triggers a fresh index (dispatch uses it for the
   *  operator "indexing…" line). */
  ensureIndexed(folder: string, onFirstIndex?: () => void | Promise<void>): Promise<void>;
}

/** Newline-delimited JSON-RPC 2.0 op timeouts. */
export const CM_LIST_TIMEOUT_MS_DEFAULT = 15_000;
export const CM_INDEX_TIMEOUT_MS_DEFAULT = 300_000;

/** Canonicalise a folder path for comparison/caching (symlink- and trailing-slash-insensitive). */
function canonical(folder: string): string {
  try {
    return realpathSync(resolve(folder));
  } catch {
    return resolve(folder);
  }
}

/** The tested core: check the folder against codebase-memory and index it if missing, with a
 *  process-lifetime cache of known-indexed folders so the common path is a no-op. */
export function makeIndexer(
  client: CodebaseMemoryClient,
  opts: { log?: (msg: string) => void } = {},
): CodebaseMemoryIndexer {
  const log = opts.log ?? (() => {});
  const known = new Set<string>();
  return {
    async ensureIndexed(folder, onFirstIndex) {
      const path = canonical(folder);
      if (known.has(path)) return; // cheap common path: already confirmed this process
      try {
        const projects = await client.listProjects();
        if (projects.some((p) => canonical(p.root_path) === path)) {
          known.add(path);
          return;
        }
        // Missing → index it (the whole point: the worker can't do this itself).
        if (onFirstIndex) await onFirstIndex();
        log(`codebase-memory: indexing ${path}`);
        await client.indexRepository(path);
        known.add(path);
        log(`codebase-memory: indexed ${path}`);
      } catch (e) {
        // Best-effort: indexing must never block a dispatch. Leave `path` uncached so a later
        // dispatch retries; the worker meanwhile falls back to reading files.
        const msg = e instanceof Error ? e.message : String(e);
        log(`codebase-memory: ensureIndexed(${path}) failed — proceeding without index: ${msg}`);
      }
    },
  };
}

/** One MCP tools/call over a freshly-spawned stdio server: initialize → initialized → call →
 *  parse result.content[0].text → kill. Rejects on JSON-RPC error, tool isError, bad JSON, or
 *  timeout. */
async function callTool(
  bin: string,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  const proc = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  const send = (obj: unknown) => {
    proc.stdin.write(JSON.stringify(obj) + "\n");
    proc.stdin.flush();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const waitFor = async (id: number): Promise<any> => {
    for (;;) {
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            if (msg.id === id) return msg;
          } catch {
            /* skip non-JSON log lines the server may print */
          }
        }
        nl = buf.indexOf("\n");
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(timedOut ? `timed out after ${timeoutMs}ms` : "stream closed before response");
      buf += dec.decode(value, { stream: true });
    }
  };
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "neo-engine", version: "1.0.0" } },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
    const res = await waitFor(2);
    if (res.error) throw new Error(res.error?.message ?? "mcp error");
    if (res.result?.isError) throw new Error(res.result?.content?.[0]?.text ?? "tool error");
    return res.result?.content?.[0]?.text ?? "";
  } finally {
    clearTimeout(timer);
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Real stdio MCP client for the codebase-memory binary. Thin IO adapter (not unit-tested; the
 *  orchestration in makeIndexer is). */
export function stdioCodebaseMemoryClient(
  bin: string,
  opts: { listTimeoutMs?: number; indexTimeoutMs?: number } = {},
): CodebaseMemoryClient {
  const listTimeoutMs = opts.listTimeoutMs ?? CM_LIST_TIMEOUT_MS_DEFAULT;
  const indexTimeoutMs = opts.indexTimeoutMs ?? CM_INDEX_TIMEOUT_MS_DEFAULT;
  return {
    async listProjects() {
      const text = await callTool(bin, "list_projects", {}, listTimeoutMs);
      const parsed = JSON.parse(text) as { projects?: CmProject[] };
      return parsed.projects ?? [];
    },
    async indexRepository(repoPath) {
      await callTool(bin, "index_repository", { repo_path: repoPath }, indexTimeoutMs);
    },
  };
}

/** Process-lifetime indexer for the configured binary, memoised by bin so its known-indexed cache
 *  is shared across every dispatch. Returns undefined when no binary is configured → dispatch skips
 *  the step (matching the worker, which also gets no codebase-memory MCP in that case). */
const sharedByBin = new Map<string, CodebaseMemoryIndexer>();
export function sharedCodebaseMemoryIndexer(cfg: NeoConfig): CodebaseMemoryIndexer | undefined {
  const bin = cfg.codebaseMemoryBin;
  if (!bin) return undefined;
  let ix = sharedByBin.get(bin);
  if (!ix) {
    ix = makeIndexer(stdioCodebaseMemoryClient(bin, { indexTimeoutMs: cfg.codebaseMemoryIndexTimeoutMs }), {
      log: (m) => console.log(`  ${m}`),
    });
    sharedByBin.set(bin, ix);
  }
  return ix;
}
