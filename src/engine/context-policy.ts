// Deterministic context policy — NO AI. Measures a session's real context load from its own
// transcript JSONL (same source of truth as usage.ts) and decides, at safe boundaries only,
// whether to keep it, hand off + clear it, or clear it immediately. Fail OPEN on read errors:
// a measurement problem must never destroy a session.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
