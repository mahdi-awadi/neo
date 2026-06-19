// Deterministic Claude-subscription usage accounting — NO AI. Sums per-turn token usage
// from Claude Code's own transcript JSONL into rolling 1h / 24h / 7d windows, reads the
// weekly reset from claude.json, and applies optional operator caps to derive "remaining".
// Every number is measured, not modelled. Ported (trimmed, functional) from operant's
// session-usage.ts — this is what replaces the meaningless dollar "budget" on a subscription.
//
// Source of truth: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl, where each assistant
// turn carries message.usage = {input_tokens, cache_creation_input_tokens,
// cache_read_input_tokens, output_tokens}.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export type UsageTurn = {
  ts: number; // epoch ms (from the line's ISO timestamp)
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
};

export type WindowUsage = {
  consumedTokens: number;
  consumedInput: number;
  consumedOutput: number;
  capTokens: number | null;
  remaining: number | null;
};

export type UsageSnapshot = {
  perWindow: { hourly: WindowUsage; daily: WindowUsage; weekly: WindowUsage };
  contextOccupancy: number; // last turn's live context fill (health signal)
  weeklyResetAt: number | null; // authoritative weekly reset from claude.json
  turnCount: number;
  computedAt: number;
};

export type UsageCaps = { hourly?: number; daily?: number; weekly?: number };

export const WINDOW_MS = { hourly: 3600_000, daily: 86400_000, weekly: 604800_000 } as const;

// --- pure functions (the unit-test surface) -------------------------------

export function parseTranscriptUsage(jsonl: string): UsageTurn[] {
  const turns: UsageTurn[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: { type?: string; timestamp?: string; message?: { usage?: Record<string, number> } };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // tolerate partial/corrupt lines
    }
    if (obj?.type !== "assistant") continue;
    const u = obj?.message?.usage;
    if (!u) continue;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    turns.push({
      ts,
      input: u.input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    });
  }
  return turns;
}

export function turnTotalTokens(t: UsageTurn): number {
  return t.input + t.cacheCreation + t.cacheRead + t.output;
}

export function tokensInWindow(
  turns: UsageTurn[],
  windowStart: number,
  windowEnd: number,
): { tokens: number; input: number; output: number } {
  let tokens = 0;
  let input = 0;
  let output = 0;
  for (const t of turns) {
    if (t.ts < windowStart || t.ts > windowEnd) continue;
    tokens += turnTotalTokens(t);
    input += t.input;
    output += t.output;
  }
  return { tokens, input, output };
}

// Live context-window occupancy = the most recent turn's input + both cache fields.
export function contextOccupancy(turns: UsageTurn[]): number {
  if (!turns.length) return 0;
  let last = turns[0];
  for (const t of turns) if (t.ts >= last.ts) last = t;
  return last.input + last.cacheCreation + last.cacheRead;
}

// Isolate the (version-fragile) claude.json read behind one adapter: any missing/renamed
// key degrades to null, never throws.
export function readPlanLimitsEndDate(claudeJson: unknown): number | null {
  const raw = (claudeJson as any)?.cachedGrowthBookFeatures?.tengu_saffron_lattice?.planLimitsEndDate;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function windowUsage(turns: UsageTurn[], now: number, span: number, cap?: number): WindowUsage {
  const { tokens, input, output } = tokensInWindow(turns, now - span, now);
  const capTokens = cap ?? null;
  return {
    consumedTokens: tokens,
    consumedInput: input,
    consumedOutput: output,
    capTokens,
    remaining: capTokens != null ? Math.max(0, capTokens - tokens) : null,
  };
}

export function computeUsageSnapshot(
  turns: UsageTurn[],
  now: number,
  opts?: { caps?: UsageCaps; weeklyResetAt?: number | null },
): UsageSnapshot {
  const caps = opts?.caps ?? {};
  return {
    perWindow: {
      hourly: windowUsage(turns, now, WINDOW_MS.hourly, caps.hourly),
      daily: windowUsage(turns, now, WINDOW_MS.daily, caps.daily),
      weekly: windowUsage(turns, now, WINDOW_MS.weekly, caps.weekly),
    },
    contextOccupancy: contextOccupancy(turns),
    weeklyResetAt: opts?.weeklyResetAt ?? null,
    turnCount: turns.length,
    computedAt: now,
  };
}

// --- meter: aggregates transcripts across all projects --------------------

export interface UsageMeter {
  snapshot(now?: number): UsageSnapshot;
}

/** Walks ~/.claude/projects, tails each transcript incrementally (cached byte offset),
 * prunes turns older than a week, and produces the snapshot /usage renders. */
export function createUsageMeter(opts: {
  projectsDir: string;
  claudeJsonPath?: string;
  caps?: UsageCaps;
}): UsageMeter {
  const files = new Map<string, { offset: number; turns: UsageTurn[] }>();

  function listTranscripts(): string[] {
    const out: string[] = [];
    let dirs: string[];
    try {
      dirs = readdirSync(opts.projectsDir);
    } catch {
      return out;
    }
    for (const d of dirs) {
      const sub = join(opts.projectsDir, d);
      try {
        if (!statSync(sub).isDirectory()) continue;
        for (const e of readdirSync(sub)) if (e.endsWith(".jsonl")) out.push(join(sub, e));
      } catch {
        continue;
      }
    }
    return out;
  }

  function refresh(now: number): UsageTurn[] {
    const cutoff = now - WINDOW_MS.weekly;
    const all: UsageTurn[] = [];
    for (const file of listTranscripts()) {
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      const state = files.get(file) ?? { offset: 0, turns: [] };
      if (size < state.offset) {
        state.offset = 0;
        state.turns = [];
      } // truncated/rotated -> reparse
      if (size > state.offset) {
        let chunk = "";
        try {
          chunk = readFileSync(file, "utf8").slice(state.offset);
        } catch {
          chunk = "";
        }
        state.turns.push(...parseTranscriptUsage(chunk));
        state.offset = size;
      }
      state.turns = state.turns.filter((t) => t.ts >= cutoff); // prune aged-out turns
      files.set(file, state);
      all.push(...state.turns);
    }
    return all;
  }

  function weeklyResetAt(): number | null {
    if (!opts.claudeJsonPath || !existsSync(opts.claudeJsonPath)) return null;
    try {
      return readPlanLimitsEndDate(JSON.parse(readFileSync(opts.claudeJsonPath, "utf8")));
    } catch {
      return null;
    }
  }

  return {
    snapshot(now = Date.now()) {
      return computeUsageSnapshot(refresh(now), now, { caps: opts.caps, weeklyResetAt: weeklyResetAt() });
    },
  };
}
