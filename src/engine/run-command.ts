// The bounded command runner (plan 2026-11-02 W0.4): the ONE way the engine runs a child process it
// does not stream (a check, a gate script, a git or gh read, the updater, a goal command). Three
// guarantees, so no caller can hang the daemon, flood the ledger or hand a worker-visible process the
// engine's keys: (1) a timeout, SIGTERM then SIGKILL, and the result returns even when a grandchild
// still holds the pipe (the old runners waited for the orphan); (2) a per-stream output cap with a
// visible marker; (3) an environment scrubbed with the worker rules (`worker-env.ts` strip mode) when
// the caller asks. It never throws: a missing binary or cwd is exit 127 with `spawnError`, a timeout
// is exit 124. Pure over Bun.spawn; nothing here reads config, the caller passes its knobs.
import { scrubWorkerEnv, type EnvScrubOptions } from "./worker-env";

/** Config `commands` (docs/CONFIG.md): the defaults a caller gets when it passes no knob. */
export interface CommandsCfg {
  /** The longest one engine-run command may take. */
  timeoutMs: number;
  /** Per stream (stdout, stderr); the rest is read and dropped, and a marker says so. */
  maxOutputChars: number;
  /** SIGTERM → SIGKILL grace at the timeout. */
  killGraceMs: number;
}

export const DEFAULT_COMMANDS_CFG: CommandsCfg = { timeoutMs: 10 * 60_000, maxOutputChars: 200_000, killGraceMs: 2_000 };

/** Parse the config value; a missing or bad field keeps its default. */
export function readCommandsCfg(raw: unknown): CommandsCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : d);
  return {
    timeoutMs: pos(r.timeoutMs, DEFAULT_COMMANDS_CFG.timeoutMs),
    maxOutputChars: pos(r.maxOutputChars, DEFAULT_COMMANDS_CFG.maxOutputChars),
    killGraceMs: pos(r.killGraceMs, DEFAULT_COMMANDS_CFG.killGraceMs),
  };
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  killGraceMs?: number;
  /** Added on top of the (possibly scrubbed) daemon environment; an overlay always wins. */
  env?: Record<string, string>;
  /** When given, the daemon environment is scrubbed with these rules first (strip mode: the engine's
   *  own keys and every relay key are removed), so the child sees what a worker sees. */
  scrub?: EnvScrubOptions;
}

export interface RunCommandResult {
  /** The exit code; 124 on a timeout, 127 when the process could not start. */
  exit: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Either stream hit `maxOutputChars` (a marker is appended to that stream). */
  truncated: boolean;
  /** Why the process could not start (missing binary or cwd); `exit` is 127 then. */
  spawnError?: string;
  durationMs: number;
}

/** Exit code for a timeout (the shell convention `timeout(1)` uses, and what `exec` returned before). */
export const EXIT_TIMEOUT = 124;
/** Exit code when the process could not be started (the shell convention for "command not found"). */
export const EXIT_SPAWN = 127;

export async function runCommand(cmd: string[], opts: RunCommandOptions = {}): Promise<RunCommandResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMANDS_CFG.timeoutMs;
  const cap = opts.maxOutputChars ?? DEFAULT_COMMANDS_CFG.maxOutputChars;
  const grace = opts.killGraceMs ?? DEFAULT_COMMANDS_CFG.killGraceMs;
  const env = childEnv(opts);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  } catch (e) {
    return { exit: EXIT_SPAWN, stdout: "", stderr: "", timedOut: false, truncated: false, spawnError: e instanceof Error ? e.message : String(e), durationMs: Date.now() - t0 };
  }

  const out = drain(proc.stdout as ReadableStream<Uint8Array> | null, cap);
  const err = drain(proc.stderr as ReadableStream<Uint8Array> | null, cap);

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, grace);
  }, timeoutMs);

  const code = await proc.exited;
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  // The process is gone. A grandchild may still hold the pipes open; the result must not wait for
  // it, so the readers are cancelled once the direct child has exited (what was read is kept).
  if (timedOut) { out.cancel(); err.cancel(); }
  const [o, e] = await Promise.all([out.done, err.done]);

  return {
    exit: timedOut ? EXIT_TIMEOUT : code,
    stdout: o.text,
    stderr: e.text,
    timedOut,
    truncated: o.truncated || e.truncated,
    durationMs: Date.now() - t0,
  };
}

/** The daemon environment, scrubbed when asked, with the caller's overlay on top. Values that are
 *  undefined in `process.env` are dropped (Bun passes strings only). */
function childEnv(opts: RunCommandOptions): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") base[k] = v;
  const scrubbed = opts.scrub ? scrubWorkerEnv(base, opts.scrub).env : base;
  return opts.env ? { ...scrubbed, ...opts.env } : scrubbed;
}

interface Drain {
  done: Promise<{ text: string; truncated: boolean }>;
  cancel(): void;
}

/** Read a stream up to `cap` chars, then keep reading and dropping so the child never blocks on a
 *  full pipe. `cancel` ends an in-flight read (a grandchild holding the pipe after the child died). */
function drain(stream: ReadableStream<Uint8Array> | null, cap: number): Drain {
  if (!stream) return { done: Promise.resolve({ text: "", truncated: false }), cancel() {} };
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  let truncated = false;
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (truncated) continue;
        text += dec.decode(value, { stream: true });
        if (text.length > cap) {
          text = text.slice(0, cap) + `\n[output truncated at ${cap} chars]`;
          truncated = true;
        }
      }
    } catch {
      // a cancelled reader rejects; what was read so far is the answer
    }
    return { text, truncated };
  })();
  return { done, cancel: () => { reader.cancel().catch(() => {}); } };
}
