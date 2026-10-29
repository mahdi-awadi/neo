// Config `todoSummary` (ADR-0059), a leaf module so config.ts reads it without importing the summarizer.
import type { EffortLevel } from "./session-runner";

export interface TodoSummaryCfg {
  /** Ask a model for a better one-line summary of each new todo (the deterministic one stays when it fails). */
  ai: boolean;
  /** A tier alias or an id (pinned through `models.aliases`, ADR-0005). */
  model: string;
  effort: EffortLevel;
  /** The run is aborted after this long; the deterministic summary stays. */
  timeoutMs: number;
}

export const DEFAULT_TODO_SUMMARY_CFG: TodoSummaryCfg = { ai: true, model: "haiku", effort: "low", timeoutMs: 30_000 };

const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Config `todoSummary`: a value of the right type is kept, anything else is the default. */
export function readTodoSummaryCfg(raw: unknown): TodoSummaryCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_TODO_SUMMARY_CFG;
  return {
    ai: typeof r.ai === "boolean" ? r.ai : d.ai,
    model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : d.model,
    effort: EFFORTS.includes(r.effort as EffortLevel) ? (r.effort as EffortLevel) : d.effort,
    timeoutMs: typeof r.timeoutMs === "number" && Number.isInteger(r.timeoutMs) && r.timeoutMs > 0 ? r.timeoutMs : d.timeoutMs,
  };
}
