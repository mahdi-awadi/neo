// Deterministic context policy — NO AI. Measures a session's real context load from its own
// transcript JSONL (same source of truth as usage.ts) and decides, at safe boundaries only,
// whether to keep it, hand off + clear it, or clear it immediately. Fail OPEN on read errors:
// a measurement problem must never destroy a session.
import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Order, SessionInfo } from "../types";
import type { Registry } from "./registry";
import type { Ledger } from "./ledger";
import { runOrder, startOrder, type RunResult, type RunDeps } from "./session-runner";

/** Context-window size is a FACT about the model, not a tuning knob. The SDK reports it on every
 *  result and the ledger keeps it per model (ADR-0013) — see contextWindows. This table holds only
 *  the fallback for a model the SDK has not reported yet. */
const MODEL_WINDOW_TOKENS: Record<string, number> = { default: 200_000 };

/** The known window per model for a measurement (ADR-0013): the SDK-reported windows from the
 *  ledger, with the operator's `contextPolicy.windowTokensByModel` overrides on top. Pass the result
 *  as `windowTokensByModel` to sessionContext / windowTokensFor. */
export function contextWindows(
  ledger: Pick<Ledger, "modelWindows">,
  overrides?: Record<string, number>,
): Record<string, number> {
  return { ...ledger.modelWindows(), ...overrides };
}

/** The context-window size (tokens) for `model`, from the facts map, with `overrides` (config)
 *  winning per model. `model === undefined` (no model found in the transcript yet) falls back to
 *  the default fact — fail-open, never throws. */
export function windowTokensFor(model: string | undefined, overrides?: Record<string, number>): number {
  return knownWindowFor(model, overrides) ?? MODEL_WINDOW_TOKENS.default;
}

/** The window for `model` when one is actually known — reported, overridden or a model fact, or a
 *  `default` the operator set — and `undefined` when windowTokensFor would only be guessing. */
function knownWindowFor(model: string | undefined, overrides?: Record<string, number>): number | undefined {
  const m: Record<string, number> = { ...MODEL_WINDOW_TOKENS, ...overrides };
  if (model !== undefined && model !== "default" && m[model]) return m[model];
  return overrides?.default || undefined;
}

export interface ContextSignals {
  occupancy: number; // last turn's input-side tokens / the model's context window (windowTokensFor)
  turns: number;
  ageMs: number;
  /** How long the session has sat idle since its transcript was last written (ms). 0 = fail-open
   *  (unmeasurable — e.g. no transcript yet). Used to gate the stale-resume rule below. */
  idleMs: number;
  /** `false` when a turn was measured but its model's window is only the default guess — no window
   *  reported or overridden yet (ADR-0013). Unset means known, or nothing measured. */
  windowKnown?: boolean;
}

export type ContextVerdict = "keep" | "handoff" | "clear";

/** WHERE the policy is asked (ADR-0014). A number crossing a line says THAT a session should be
 *  replaced, never WHEN — so the engine only asks at one of these moments:
 *  - `resume`: an idle session is about to be reused for a new task (often a cold cache);
 *  - `settled`: a task just finished and the session is at rest (warm cache);
 *  - `checkpoint`: mid-task, right after a commit or a completed plan step, with a clean tree. */
export type ContextBoundary = "resume" | "settled" | "checkpoint";

/** Where occupancy sits, in one word (CONTEXT.md "Context band"). */
export type ContextBand = "healthy" | "above" | "heavy" | "emergency";

export type ContextReason =
  | "emergency"
  | "above-sweet-spot"
  | "heavy"
  | "projected-overflow"
  | "stale-resume"
  | "max-turns"
  | "max-age";

export interface ContextDecision {
  verdict: ContextVerdict;
  /** Why — set on every `handoff`/`clear`, recorded in the ledger and shown to the operator. */
  reason?: ContextReason;
  band: ContextBand;
}

export interface ContextPolicyCfg {
  /** RATIO (0-1): the top of the sweet spot. Above it a session is handed off at its next task
   *  boundary (`resume` / `settled`). Was `handoffPct` 0.65; 0.40 from transcript data (ADR-0014). */
  sweetSpotPct: number;
  /** RATIO (0-1): above it a session is also handed off at the next SAFE CHECKPOINT, mid-task.
   *  Set it to 1 or more to turn mid-task handoffs off. */
  checkpointPct: number;
  /** RATIO (0-1): the last-resort line, below the SDK's own auto-compaction (~0.97). */
  emergencyPct: number;
  /** Max characters of a handoff note inlined into a continuation's first brief. */
  handoffNoteMaxChars: number;
  /** A resumed session that reaches its first productive action (an edit or a commit) within this
   *  many model calls counts as a successful handoff (CONTEXT.md "Orientation"). */
  handoffOrientationMaxSteps: number;
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
  /** OPERATOR CHOICE: rolling sample size for the learned-cache-TTL window — how many of the most
   *  recent (gapMs, hit) observations the learner keeps. Optional; falls back to CACHE_OBS_WINDOW
   *  when unset (e.g. a hand-built test fixture). */
  cacheObsWindow?: number;
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

export function contextBand(
  occupancy: number,
  cfg: Pick<ContextPolicyCfg, "sweetSpotPct" | "checkpointPct" | "emergencyPct">,
): ContextBand {
  if (occupancy >= cfg.emergencyPct) return "emergency";
  if (occupancy >= cfg.checkpointPct) return "heavy";
  if (occupancy >= cfg.sweetSpotPct) return "above";
  return "healthy";
}

/** THE context policy (one, deterministic). `at` says where it is asked (ADR-0014); `projected` is
 *  the occupancy the current plan is on course to reach (checkpoint only). */
export function decideContext(
  sig: ContextSignals,
  cfg: ContextPolicyCfg,
  ttlMs: number,
  at: { boundary: ContextBoundary; projected?: number } = { boundary: "resume" },
): ContextDecision {
  const band = contextBand(sig.occupancy, cfg);
  const known = sig.windowKnown !== false;
  const handoff = (reason: ContextReason): ContextDecision => ({ verdict: "handoff", reason, band });
  // The last resort. Only a cold resume of a known-full session is cleared: everywhere else a note
  // still fits, and a guessed window must never destroy a session (ADR-0013).
  if (band === "emergency") return at.boundary === "resume" && known ? { verdict: "clear", reason: "emergency", band } : handoff("emergency");
  if (at.boundary === "resume" && sig.idleMs >= ttlMs && sig.occupancy >= cfg.staleResumePct) return handoff("stale-resume");
  if (at.boundary === "checkpoint") {
    // Mid-task: only a heavy session, or one its own plan will carry past the emergency line.
    if (!known) return { verdict: "keep", band };
    if (band === "heavy") return handoff("heavy");
    if (band === "above" && (at.projected ?? 0) >= cfg.emergencyPct) return handoff("projected-overflow");
    return { verdict: "keep", band };
  }
  if (known && band !== "healthy") return handoff("above-sweet-spot");
  if (sig.turns >= cfg.maxTurns) return handoff("max-turns");
  if (sig.ageMs >= cfg.maxAgeMs) return handoff("max-age");
  return { verdict: "keep", band };
}

/** Running totals of one transcript, up to `offset` (the byte after its last complete line). */
interface TranscriptTally {
  offset: number;
  turns: number;
  firstTs: number;
  lastInputSide: number;
  lastModel?: string;
}

// Transcripts are append-only and grow to tens of MB, and every live session is measured on each
// console poll and gate check. So each path keeps its tally and a call parses only the appended
// bytes. A file smaller than the tally's offset was rewritten: it is read again from the start.
const tallies = new Map<string, TranscriptTally>();

function foldLines(t: TranscriptTally, text: string): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: { type?: string; timestamp?: string; message?: { usage?: Record<string, number>; model?: string } };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!t.firstTs && Number.isFinite(ts)) t.firstTs = ts;
    const u = obj.type === "assistant" ? obj.message?.usage : undefined;
    if (!u) continue;
    t.turns++;
    t.lastInputSide = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    t.lastModel = obj.message?.model ?? t.lastModel;
  }
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
    if (!existsSync(path)) {
      tallies.delete(path);
      return none;
    }
    const st = statSync(path);
    let t = tallies.get(path);
    if (!t || st.size < t.offset) t = { offset: 0, turns: 0, firstTs: 0, lastInputSide: 0 };
    let tail = "";
    if (st.size > t.offset) {
      const buf = Buffer.alloc(st.size - t.offset);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, buf.length, t.offset);
      } finally {
        closeSync(fd);
      }
      // Commit only complete lines (split on the byte, so a multi-byte character is never cut).
      const cut = buf.lastIndexOf(0x0a) + 1;
      foldLines(t, buf.subarray(0, cut).toString("utf8"));
      t.offset += cut;
      tail = buf.subarray(cut).toString("utf8");
    }
    tallies.set(path, t);
    // A last line with no newline yet still counts now, but is not committed: it is re-read when completed.
    const view = tail ? { ...t } : t;
    if (tail) foldLines(view, tail);
    return {
      occupancy: view.lastInputSide / windowTokensFor(view.lastModel, opts.windowTokensByModel),
      ...(view.turns > 0 && knownWindowFor(view.lastModel, opts.windowTokensByModel) === undefined ? { windowKnown: false } : {}),
      turns: view.turns,
      ageMs: view.firstTs ? Math.max(0, now() - view.firstTs) : 0,
      idleMs: Math.max(0, now() - st.mtimeMs),
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
  const sig = sessionContext(session.order.folder, session.sdkSessionId, { windowTokensByModel: contextWindows(deps.ledger, cfg.windowTokensByModel) });
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
      active: () => false,
      done,
    } as unknown as ReturnType<typeof startOrder>;
  };
}
