// The engine's own tiny client for the codebase-memory MCP server + the "ensure indexed" guard
// dispatch runs before a worker starts. The engine has no AI, but it CAN speak MCP: the governor
// denies subagents index_repository/list_projects, so a dispatched worker can never self-index —
// the main/engine side must guarantee the index. Two layers: a thin stdio JSON-RPC adapter (real
// IO, not unit-tested) and makeIndexer (the tested orchestration). It checks on EVERY dispatch and
// refreshes when the repo's HEAD moved, because the binary rebuilds a project's DB on any change and
// can lose it in a crash; it hands dispatch the exact project name (ADR-0028).
// Spec: docs/superpowers/specs/2026-07-21-dispatch-mandatory-codebase-memory-design.md
import { spawnSync } from "node:child_process";
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

/** What ensureIndexed hands dispatch: the exact codebase-memory project name for the folder, or none
 *  when no index could be made (the worker then reads files). */
export interface IndexResult {
  project?: string;
}

/** What dispatch depends on: ensure `folder` is indexed and fresh before the worker runs. */
export interface CodebaseMemoryIndexer {
  /** Checks codebase-memory on every call: indexes a missing folder, refreshes one whose HEAD moved
   *  since the engine last indexed it, and returns the project name. Best-effort: NEVER throws — on
   *  any failure it logs and resolves (with no project when there is no index at all), so a dispatch
   *  is never blocked by indexing. `onFirstIndex` fires only when THIS call builds a missing index
   *  (dispatch uses it for the operator "indexing…" line); a refresh is quiet. */
  ensureIndexed(folder: string, onFirstIndex?: () => void | Promise<void>): Promise<IndexResult>;
}

/** Where the engine remembers the HEAD it last indexed each folder at (durable: the ledger's meta). */
export interface IndexStore {
  get(folder: string): string | undefined;
  set(folder: string, head: string): void;
}

/** The folder's committed state — its HEAD sha — or undefined when it is not a git repo. The index is a
 *  map of committed code; a worker reads its own uncommitted work directly. */
export function gitHead(folder: string): string | undefined {
  const r = spawnSync("git", ["-C", folder, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 });
  const sha = r.status === 0 ? r.stdout.trim() : "";
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined;
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

/** The tested core: on every call, look the folder up in codebase-memory; index it when missing,
 *  refresh it when its HEAD moved since the engine last indexed it (the binary's own file hashes make
 *  an unchanged repo cheap), and return the exact project name. Concurrent calls for one folder share
 *  one run. There is deliberately no "already indexed" cache: the binary can lose a DB after the
 *  first check (it rebuilds the whole DB on any change), so a cached "yes" went stale for every later
 *  dispatch until a restart. */
export function makeIndexer(
  client: CodebaseMemoryClient,
  opts: { log?: (msg: string) => void; store?: IndexStore; fingerprint?: (folder: string) => string | undefined } = {},
): CodebaseMemoryIndexer {
  const log = opts.log ?? (() => {});
  const memory = new Map<string, string>();
  const store: IndexStore = opts.store ?? { get: (f) => memory.get(f), set: (f, v) => void memory.set(f, v) };
  const fingerprint = opts.fingerprint ?? gitHead;
  const inFlight = new Map<string, Promise<IndexResult>>();
  const nameOf = (projects: CmProject[], path: string) => projects.find((p) => canonical(p.root_path) === path)?.name;

  const run = async (path: string, onFirstIndex?: () => void | Promise<void>): Promise<IndexResult> => {
    let name: string | undefined;
    try {
      name = nameOf(await client.listProjects(), path);
      const head = fingerprint(path);
      if (name && (head === undefined || store.get(path) === head)) return { project: name }; // present and fresh
      if (!name && onFirstIndex) await onFirstIndex();
      log(`codebase-memory: ${name ? "refreshing" : "indexing"} ${path}${head ? ` at ${head.slice(0, 12)}` : ""}`);
      await client.indexRepository(path);
      const after = nameOf(await client.listProjects(), path);
      if (!after) throw new Error("index_repository finished but the project is not listed");
      if (head) store.set(path, head);
      log(`codebase-memory: indexed ${path} as ${after}`);
      return { project: after };
    } catch (e) {
      // Best-effort: indexing must never block a dispatch. Nothing is recorded, so the next dispatch
      // retries. A failed REFRESH still hands out the existing (stale) index — better than none.
      const msg = e instanceof Error ? e.message : String(e);
      log(`codebase-memory: ensureIndexed(${path}) failed${name ? " — using the existing index" : " — proceeding without index"}: ${msg}`);
      return name ? { project: name } : {};
    }
  };

  return {
    ensureIndexed(folder, onFirstIndex) {
      const path = canonical(folder);
      const running = inFlight.get(path);
      if (running) return running;
      const p = run(path, onFirstIndex).finally(() => inFlight.delete(path));
      inFlight.set(path, p);
      return p;
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

/** The ledger-backed store of the HEAD each folder was last indexed at — survives a restart, so a
 *  restart does not force a re-index of every project. */
export function ledgerIndexStore(ledger: { getMeta(key: string): { value: unknown } | undefined; setMeta(key: string, value: unknown, at: number): void }): IndexStore {
  const key = (folder: string) => `cbm:${folder}`;
  return {
    get: (folder) => {
      const v = ledger.getMeta(key(folder))?.value;
      return typeof v === "string" ? v : undefined;
    },
    set: (folder, head) => ledger.setMeta(key(folder), head, Date.now()),
  };
}

/** Process-lifetime indexer for the configured binary, memoised by bin so its in-flight runs are
 *  shared across every dispatch. Returns undefined when no binary is configured → dispatch skips
 *  the step (matching the worker, which also gets no codebase-memory MCP in that case). */
const sharedByBin = new Map<string, CodebaseMemoryIndexer>();
export function sharedCodebaseMemoryIndexer(cfg: NeoConfig, store?: IndexStore): CodebaseMemoryIndexer | undefined {
  const bin = cfg.codebaseMemoryBin;
  if (!bin) return undefined;
  let ix = sharedByBin.get(bin);
  if (!ix) {
    ix = makeIndexer(stdioCodebaseMemoryClient(bin, { indexTimeoutMs: cfg.codebaseMemoryIndexTimeoutMs, listTimeoutMs: cfg.codebaseMemoryListTimeoutMs }), {
      log: (m) => console.log(`  ${m}`),
      ...(store ? { store } : {}),
    });
    sharedByBin.set(bin, ix);
  }
  return ix;
}
