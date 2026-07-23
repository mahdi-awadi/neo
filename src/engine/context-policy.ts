// Deterministic context policy — NO AI. Measures a session's real context load from its own
// transcript JSONL (same source of truth as usage.ts) and decides, at safe boundaries only,
// whether to keep it, hand off + clear it, or clear it immediately. Fail OPEN on read errors:
// a measurement problem must never destroy a session.
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Order, SessionInfo } from "../types";
import type { Registry } from "./registry";
import type { Ledger } from "./ledger";
import { runOrder, startOrder, type RunResult, type RunDeps } from "./session-runner";

/** Context-window size is a FACT about the model, not a tuning knob — one global constant would be
 *  wrong the moment two different models are in play. Keyed by the model id Claude Code's own
 *  transcripts report (`message.model`); `default` is the conservative fallback for an unknown or
 *  absent model. Config may override per model (operator choice over facts) via
 *  ContextPolicyCfg.windowTokensByModel — see windowTokensFor. */
const MODEL_WINDOW_TOKENS: Record<string, number> = { default: 200_000 };

/** The context-window size (tokens) for `model`, from the facts map, with `overrides` (config)
 *  winning per model. `model === undefined` (no model found in the transcript yet) falls back to
 *  the default fact — fail-open, never throws. */
export function windowTokensFor(model: string | undefined, overrides?: Record<string, number>): number {
  const m = { ...MODEL_WINDOW_TOKENS, ...overrides };
  return (model !== undefined && m[model]) || m.default;
}

export interface ContextSignals {
  occupancy: number; // last turn's input-side tokens / the model's context window (windowTokensFor)
  turns: number;
  ageMs: number;
  /** How long the session has sat idle since its transcript was last written (ms). 0 = fail-open
   *  (unmeasurable — e.g. no transcript yet). Used to gate the stale-resume rule below. */
  idleMs: number;
}

export type ContextVerdict = "keep" | "handoff" | "clear";

export interface ContextPolicyCfg {
  handoffPct: number;
  emergencyPct: number;
  maxTurns: number;
  maxAgeMs: number;
  handoffTimeoutMs: number;
  /** RATIO (0-1): occupancy above which a resume idle past the effective cache TTL is treated as
   *  stale enough to hand off (avoids paying a cold, unwarmed-cache resume on a fat transcript). */
  staleResumePct: number;
  /** PROVIDER-FACT FALLBACK (ms): the provider-documented prompt-cache TTL, used only until enough
   *  real observations exist to derive a learned TTL (see effectiveCacheTtlMs). */
  cacheTtlFallbackMs: number;
  /** OPERATOR CHOICE: minimum number of (gapMs, hit) observations required before the learned TTL
   *  is trusted over cacheTtlFallbackMs. */
  cacheTtlMinObservations: number;
  /** OPERATOR CHOICE: per-model context-window overrides, layered over the built-in facts map
   *  (windowTokensFor's MODEL_WINDOW_TOKENS). Optional — absent/unset models fall back to the
   *  facts map's own default. Not a new fixed knob: the window is still derived from the model
   *  the transcript reports; this only lets an operator correct or extend the facts map. Threaded
   *  into every sessionContext call that feeds a keep/handoff/clear decision — dispatch.ts's
   *  gate, pipeline.ts's pre- and post-resume gates, loops.ts's loop-resume gate, and
   *  runHandoff's own re-measurement — so a configured override actually changes gate verdicts,
   *  not just the number shown for /status ctx%. */
  windowTokensByModel?: Record<string, number>;
}

/** OPERATOR-CHOICE-style rolling sample size bounding the LEARNED-cache-TTL observation window
 *  (effectiveCacheTtlMs's `obs`): how many of the most recent (gapMs, hit) observations the
 *  learner keeps in its rolling memory. Not a provider fact — a deliberately small, easy-to-reason-
 *  about bound, supersedable by real telemetry later. One constant, used everywhere an observation
 *  window is read (the ledger's own default + every call site that passes an explicit limit), so
 *  they can never drift apart. */
export const CACHE_OBS_WINDOW = 50;

/** Claude Code's project-dir encoding for a cwd: every "/" and "." becomes "-". */
export function encodeCwd(folder: string): string {
  return folder.replace(/[/.]/g, "-");
}

/** Deterministic learned TTL: midpoint between the longest idle gap that still hit the prompt
 *  cache and the shortest gap that missed. Falls back to the provider-documented TTL until
 *  cacheTtlMinObservations exist or the observations don't yet bracket the boundary. */
export function effectiveCacheTtlMs(
  obs: { gapMs: number; hit: boolean }[],
  cfg: ContextPolicyCfg,
): number {
  if (obs.length < cfg.cacheTtlMinObservations) return cfg.cacheTtlFallbackMs;
  const hits = obs.filter((o) => o.hit).map((o) => o.gapMs);
  const misses = obs.filter((o) => !o.hit).map((o) => o.gapMs);
  if (!hits.length || !misses.length) return cfg.cacheTtlFallbackMs;
  const hi = Math.max(...hits);
  const lo = Math.min(...misses);
  return lo > hi ? (hi + lo) / 2 : cfg.cacheTtlFallbackMs; // overlapping data → not learnable yet
}

export function decideContext(sig: ContextSignals, cfg: ContextPolicyCfg, ttlMs: number): ContextVerdict {
  if (sig.occupancy >= cfg.emergencyPct) return "clear";
  if (sig.idleMs >= ttlMs && sig.occupancy >= cfg.staleResumePct) return "handoff";
  if (sig.occupancy >= cfg.handoffPct || sig.turns >= cfg.maxTurns || sig.ageMs >= cfg.maxAgeMs) return "handoff";
  return "keep";
}

/** Measured signals for one session, from ~/.claude/projects/<encodeCwd(folder)>/<id>.jsonl. */
export function sessionContext(
  folder: string,
  sdkSessionId: string,
  opts: { projectsDir?: string; now?: () => number; windowTokensByModel?: Record<string, number> } = {},
): ContextSignals {
  const none: ContextSignals = { occupancy: 0, turns: 0, ageMs: 0, idleMs: 0 };
  if (!folder || !sdkSessionId) return none;
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  const now = opts.now ?? (() => Date.now());
  const path = join(projectsDir, encodeCwd(folder), `${sdkSessionId}.jsonl`);
  try {
    if (!existsSync(path)) return none;
    let turns = 0;
    let firstTs = 0;
    let lastInputSide = 0;
    let lastModel: string | undefined;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: { type?: string; timestamp?: string; message?: { usage?: Record<string, number>; model?: string } };
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (!firstTs && Number.isFinite(ts)) firstTs = ts;
      const u = obj.type === "assistant" ? obj.message?.usage : undefined;
      if (!u) continue;
      turns++;
      lastInputSide = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      lastModel = obj.message?.model ?? lastModel;
    }
    return {
      occupancy: lastInputSide / windowTokensFor(lastModel, opts.windowTokensByModel),
      turns,
      ageMs: firstTs ? Math.max(0, now() - firstTs) : 0,
      idleMs: Math.max(0, now() - statSync(path).mtimeMs),
    };
  } catch {
    return none; // fail OPEN
  }
}

/** Total line count of a session's transcript file right now (same path sessionContext reads).
 *  Captured at the context-policy gate, BEFORE a resume, so the caller can later scan only the
 *  lines appended AFTER that point (see firstAssistantCacheReadAfter) — scanning the whole
 *  transcript would pick up a LATER turn, which reflects a cache the resume's own first turn just
 *  rewarmed, not the idle gap being measured. `undefined` when unreadable; fail-open, never throws. */
export function transcriptLineCount(
  folder: string,
  sdkSessionId: string,
  opts: { projectsDir?: string } = {},
): number | undefined {
  if (!folder || !sdkSessionId) return undefined;
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  const path = join(projectsDir, encodeCwd(folder), `${sdkSessionId}.jsonl`);
  try {
    if (!existsSync(path)) return undefined;
    // Every real transcript line (including the last) is newline-terminated, so a naive
    // `.split("\n")` counts a phantom trailing "" element (a 1-record file would count as 2).
    // Strip exactly one trailing newline first so this count lines up with the SAME strip
    // firstAssistantCacheReadAfter applies before indexing — otherwise `afterLine` would land one
    // index too far once the resume's own newline-terminated lines are appended.
    return readFileSync(path, "utf8").replace(/\n$/, "").split("\n").length;
  } catch {
    return undefined; // fail OPEN
  }
}

/** The FIRST assistant turn strictly after line index `afterLine` that carries usage — i.e. the
 *  FIRST post-resume turn, whose `cache_read_input_tokens` is the only turn that actually reflects
 *  whether the prompt cache survived the idle gap (a later turn in the same run would already hit
 *  the cache that first turn just recreated, so scanning past it would starve the misses bucket and
 *  defeat the learned TTL). Pass `afterLine: 0` to read a transcript from its start (e.g. when the
 *  SDK forked a new transcript file for the resume). Returns `undefined` when the transcript can't
 *  be read or has no matching turn (yet), so a caller can skip recording rather than misrecord a
 *  false miss; fail-open, never throws. */
export function firstAssistantCacheReadAfter(
  folder: string,
  sdkSessionId: string,
  afterLine: number,
  opts: { projectsDir?: string } = {},
): number | undefined {
  if (!folder || !sdkSessionId) return undefined;
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  const path = join(projectsDir, encodeCwd(folder), `${sdkSessionId}.jsonl`);
  try {
    if (!existsSync(path)) return undefined;
    // Same trailing-newline strip as transcriptLineCount, so an `afterLine` captured from that
    // count indexes into the SAME (phantom-element-free) split here.
    const lines = readFileSync(path, "utf8").replace(/\n$/, "").split("\n");
    for (let i = Math.max(0, afterLine); i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let obj: { type?: string; message?: { usage?: Record<string, number> } };
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const u = obj.type === "assistant" ? obj.message?.usage : undefined;
      if (!u) continue;
      return u.cache_read_input_tokens ?? 0;
    }
    return undefined; // no post-resume assistant turn found (yet) — skip, don't misrecord
  } catch {
    return undefined; // fail OPEN
  }
}

export const HANDOFF_PROMPT =
  "Write a concise state-of-work handoff to HANDOFF.md in the project root: what is in flight, " +
  "decisions made, blockers, and next steps. Overwrite any existing HANDOFF.md. Then stop — do not continue other work.";

/** Prepended to HANDOFF_PROMPT (never merged into it — HANDOFF_PROMPT stays byte-identical for
 *  the Phase-1 fence) when a handoff fires for a memory-scoped folder, so the worker captures
 *  durable facts/decisions into memory BEFORE it writes the (separate, ephemeral) HANDOFF.md note.
 *  Gated by the same memoryScopeEnabled check every other memory injection uses — see runHandoff's
 *  `deps.memoryFlush` and its callers in pipeline.ts/dispatch.ts. */
export const MEMORY_FLUSH_SENTENCE =
  "Before writing the handoff note: save any durable facts, decisions, or workarounds from this " +
  "session with the memory tool, and append a one-line session summary to today's memory log.";

/** A short, DETERMINISTIC state-of-work note (no worker/AI) for HANDOFF.md, written when a quiet
 *  session is idle-closed — so the next run knows where it left off even when no context-boundary
 *  handoff (the richer, worker-written HANDOFF_PROMPT above) fired. Reuses the SAME single HANDOFF.md
 *  file that the fresh-start path already tells a worker to "Read first" (pipeline.startSession) and
 *  that the dispatch preamble surfaces as a root-level .md — so it's discoverable with no extra wiring. */
export function idleStateNote(session: SessionInfo, now: number): string {
  const activity = session.activity?.label;
  return [
    `# HANDOFF — ${session.name}`,
    "",
    "_Auto-written by Neo when this session was idle-closed (a deterministic engine note, not a",
    "worker turn). It records where the session left off so the next run can pick up; it is",
    "overwritten each time the session is closed._",
    "",
    `- Folder: ${session.order.folder}`,
    `- Opening brief: ${session.order.task || "(none)"}`,
    `- Last activity: ${activity || "(unknown)"}`,
    `- Idle-closed at: ${new Date(now).toISOString()}`,
    "",
    "## Outstanding",
    "The session went quiet and was closed to free the subscription pool. If work was mid-flight,",
    "re-read this and continue from the last activity above; otherwise treat the opening brief as done.",
  ].join("\n");
}

export interface WriteNoteOpts {
  now?: () => number;
  /** Injectable writer (tests); defaults to writeFileSync. */
  write?: (path: string, content: string) => void;
}

/** Best-effort: write idleStateNote to HANDOFF.md in the project folder. NEVER throws — a failed
 *  note must not break the idle-close sweep. */
export function writeIdleStateNote(session: SessionInfo, opts: WriteNoteOpts = {}): void {
  const now = opts.now ?? (() => Date.now());
  const write = opts.write ?? ((path: string, content: string) => writeFileSync(path, content));
  try {
    write(join(session.order.folder, "HANDOFF.md"), idleStateNote(session, now()));
  } catch {
    // best-effort — idle-close must proceed regardless
  }
}

export interface HandoffDeps {
  registry: Registry;
  ledger: Ledger;
  /** Preferred seam: a live, interruptible run (so a timed-out handoff can be aborted instead
   *  of abandoned as an unbounded background worker on the folder). */
  start?: typeof startOrder;
  /** Legacy single-shot seam (still accepted for old callers/tests) — wrapped so it can still
   *  be raced against the timeout, but it has no interrupt handle (best-effort no-op). */
  run?: typeof runOrder;
  now?: () => number;
  /** Path-profile RunDeps (model/effort/skills/env) for this handoff turn, e.g.
   *  `profileDeps(cfg, "handoff")`. Merged over the fixed resume/effort base below. */
  runDeps?: RunDeps;
  /** True when the session's folder is in memory scope (caller's `memoryScopeEnabled` check) —
   *  prepends MEMORY_FLUSH_SENTENCE to the handoff task so the worker saves durable facts to
   *  memory before writing HANDOFF.md. Absent/false → task is HANDOFF_PROMPT, byte-identical to
   *  before this field existed. */
  memoryFlush?: boolean;
}

/** Run the handoff turn against the fat session (bounded), then ALWAYS clear its resume state.
 *  If the turn doesn't finish within `cfg.handoffTimeoutMs`, it is INTERRUPTED (not abandoned) —
 *  an abandoned handoff would leave an unbounded worker running on the folder, which could race
 *  with a subsequent fresh session on the same folder. */
export async function runHandoff(session: SessionInfo, cfg: ContextPolicyCfg, deps: HandoffDeps): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const sig = sessionContext(session.order.folder, session.sdkSessionId, { windowTokensByModel: cfg.windowTokensByModel });
  const order: Order = {
    id: crypto.randomUUID(),
    source: "neo",
    folder: session.order.folder,
    task: deps.memoryFlush ? MEMORY_FLUSH_SENTENCE + "\n\n" + HANDOFF_PROMPT : HANDOFF_PROMPT,
    chatId: session.order.chatId,
    createdAt: now(),
  };
  const start = deps.start ?? (deps.run ? wrapRunAsStart(deps.run) : startOrder);
  try {
    const run = start(
      order,
      { onMessage: () => {}, onEscalation: async () => "deny" },
      { resume: session.sdkSessionId || undefined, effort: "low", ...deps.runDeps },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), cfg.handoffTimeoutMs);
    });
    const settled = await Promise.race([run.done, timeout]);
    if (settled === "timeout") {
      await run.interrupt();
    } else {
      clearTimeout(timer);
    }
  } catch {
    // the clear below is the point; a failed handoff turn must not prevent it
  }
  try {
    deps.registry.setSdkSessionId(session.id, "");
    deps.ledger.clearSessionsFor(session.order.folder);
    deps.ledger.recordContextEvent(session.order.folder, "handoff", sig.occupancy, now());
  } catch {
    // observer-grade bookkeeping — never throw into a worker path
  }
}

/** Adapt a legacy single-shot `runOrder`-shaped function into the `startOrder` SessionRun shape,
 *  so old `run:` test seams keep working while the main path prefers the interruptible `start`. */
function wrapRunAsStart(run: typeof runOrder): typeof startOrder {
  return (order, handlers, runDeps) => {
    const done: Promise<RunResult> = run(order, handlers, runDeps);
    return {
      followUp: () => {},
      interrupt: async () => {
        // best-effort — the legacy single-shot seam has no real interrupt handle
      },
      queued: () => 0,
      done,
    } as unknown as ReturnType<typeof startOrder>;
  };
}
