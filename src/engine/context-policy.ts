// Deterministic context policy — NO AI. Measures a session's real context load from its own
// transcript JSONL (same source of truth as usage.ts) and decides, at safe boundaries only,
// whether to keep it, hand off + clear it, or clear it immediately. Fail OPEN on read errors:
// a measurement problem must never destroy a session.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Order, SessionInfo } from "../types";
import type { Registry } from "./registry";
import type { Ledger } from "./ledger";
import { runOrder, startOrder, type RunResult, type RunDeps } from "./session-runner";

export const CONTEXT_WINDOW_TOKENS = 200_000;

export interface ContextSignals {
  occupancy: number; // last turn's input-side tokens / CONTEXT_WINDOW_TOKENS
  turns: number;
  ageMs: number;
}

export type ContextVerdict = "keep" | "handoff" | "clear";

export interface ContextPolicyCfg {
  handoffPct: number;
  emergencyPct: number;
  maxTurns: number;
  maxAgeMs: number;
  handoffTimeoutMs: number;
}

/** Claude Code's project-dir encoding for a cwd: every "/" and "." becomes "-". */
export function encodeCwd(folder: string): string {
  return folder.replace(/[/.]/g, "-");
}

export function decideContext(sig: ContextSignals, cfg: ContextPolicyCfg): ContextVerdict {
  if (sig.occupancy >= cfg.emergencyPct) return "clear";
  if (sig.occupancy >= cfg.handoffPct || sig.turns >= cfg.maxTurns || sig.ageMs >= cfg.maxAgeMs) return "handoff";
  return "keep";
}

/** Measured signals for one session, from ~/.claude/projects/<encodeCwd(folder)>/<id>.jsonl. */
export function sessionContext(
  folder: string,
  sdkSessionId: string,
  opts: { projectsDir?: string; now?: () => number } = {},
): ContextSignals {
  const none: ContextSignals = { occupancy: 0, turns: 0, ageMs: 0 };
  if (!folder || !sdkSessionId) return none;
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  const now = opts.now ?? (() => Date.now());
  const path = join(projectsDir, encodeCwd(folder), `${sdkSessionId}.jsonl`);
  try {
    if (!existsSync(path)) return none;
    let turns = 0;
    let firstTs = 0;
    let lastInputSide = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: { type?: string; timestamp?: string; message?: { usage?: Record<string, number> } };
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
    }
    return {
      occupancy: lastInputSide / CONTEXT_WINDOW_TOKENS,
      turns,
      ageMs: firstTs ? Math.max(0, now() - firstTs) : 0,
    };
  } catch {
    return none; // fail OPEN
  }
}

export const HANDOFF_PROMPT =
  "Write a concise state-of-work handoff to HANDOFF.md in the project root: what is in flight, " +
  "decisions made, blockers, and next steps. Overwrite any existing HANDOFF.md. Then stop — do not continue other work.";

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
}

/** Run the handoff turn against the fat session (bounded), then ALWAYS clear its resume state.
 *  If the turn doesn't finish within `cfg.handoffTimeoutMs`, it is INTERRUPTED (not abandoned) —
 *  an abandoned handoff would leave an unbounded worker running on the folder, which could race
 *  with a subsequent fresh session on the same folder. */
export async function runHandoff(session: SessionInfo, cfg: ContextPolicyCfg, deps: HandoffDeps): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const sig = sessionContext(session.order.folder, session.sdkSessionId);
  const order: Order = {
    id: crypto.randomUUID(),
    source: "neo",
    folder: session.order.folder,
    task: HANDOFF_PROMPT,
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
