// The real `UpdateSys` (ADR-0009): processes, HTTP, files, and an MCP stdio probe. Kept thin — every
// rule lives in updater.ts and the update-* sources, which are tested against a fake of this port.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecResult, McpLaunch, UpdateSys } from "./updater";
import { EXIT_SPAWN, EXIT_TIMEOUT, runCommand } from "./run-command";

const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
/** A git log, a gh JSON listing or an updater build log; never a worker's stream. */
const EXEC_OUTPUT_MAX = 10 * 1024 * 1024;
/** GitHub's API refuses requests without a User-Agent. */
const HEADERS = { "user-agent": "neo-updater", accept: "application/json, text/plain, */*" };
/** The MCP protocol version the probe offers; servers answer with the one they speak. */
const MCP_PROTOCOL = "2025-06-18";

/** One bounded child process: never throws (a missing binary or cwd is code 127), killed past its
 *  timeout (code 124). `env` adds to the daemon's environment. A thin shape over the engine's one
 *  runner (`run-command.ts`, W0.4): the updater, and git/gh reads through git-read.ts, keep this
 *  `ExecResult` contract; the output cap is the runner's (large enough for any git or gh read). */
export async function exec(cmd: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const r = await runCommand(cmd, { cwd: opts.cwd, timeoutMs, env: opts.env, maxOutputChars: EXEC_OUTPUT_MAX });
  if (r.spawnError !== undefined) return { code: EXIT_SPAWN, out: "", err: r.spawnError }; // missing binary / cwd
  return r.timedOut ? { code: EXIT_TIMEOUT, out: r.stdout, err: `${r.stderr}\n[timed out after ${timeoutMs}ms]` } : { code: r.exit, out: r.stdout, err: r.stderr };
}

/** Start an MCP stdio server, `initialize`, `tools/list`, stop it. */
async function probeMcp(launch: McpLaunch, timeoutMs: number): Promise<{ ok: boolean; tools: number; error?: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([launch.command, ...launch.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...(launch.env ?? {}) },
    });
  } catch (e) {
    return { ok: false, tools: 0, error: `could not start: ${e instanceof Error ? e.message : String(e)}` };
  }
  const stdin = proc.stdin as import("bun").FileSink;
  const send = (msg: unknown) => {
    stdin.write(`${JSON.stringify(msg)}\n`);
    stdin.flush();
  };
  const result = new Promise<{ ok: boolean; tools: number; error?: string }>((resolve) => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const pump = async (): Promise<void> => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return resolve({ ok: false, tools: 0, error: "the server exited before listing its tools" });
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // a log line on stdout
          }
          if (msg.id === 1) {
            if (msg.error) return resolve({ ok: false, tools: 0, error: `initialize: ${msg.error.message ?? "error"}` });
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          } else if (msg.id === 2) {
            if (msg.error) return resolve({ ok: false, tools: 0, error: `tools/list: ${msg.error.message ?? "error"}` });
            const tools = msg.result?.tools?.length ?? 0;
            return resolve({ ok: true, tools });
          }
        }
      }
    };
    void pump().catch((e) => resolve({ ok: false, tools: 0, error: String(e) }));
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "neo-updater", version: "1" } } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: boolean; tools: number; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, tools: 0, error: `no tools/list reply within ${timeoutMs}ms` }), timeoutMs);
  });
  const r = await Promise.race([result, timeout]);
  clearTimeout(timer);
  try {
    proc.kill();
  } catch {
    // already gone
  }
  return r;
}

export function realUpdateSys(): UpdateSys {
  return {
    exec,
    async fetchText(url) {
      try {
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        return res.ok ? await res.text() : undefined;
      } catch {
        return undefined;
      }
    },
    async download(url, dest) {
      try {
        const res = await fetch(url, { headers: { "user-agent": HEADERS["user-agent"] }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) return false;
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
        return true;
      } catch {
        return false;
      }
    },
    sha256(path) {
      try {
        return createHash("sha256").update(readFileSync(path)).digest("hex");
      } catch {
        return undefined;
      }
    },
    readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeFile(path, text) {
      const tmp = `${path}.neo-tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, path);
    },
    exists: (path) => existsSync(path),
    copyFile: (from, to) => copyFileSync(from, to),
    rename: (from, to) => renameSync(from, to),
    listDir(path) {
      try {
        return readdirSync(path, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
    probeMcp,
  };
}
