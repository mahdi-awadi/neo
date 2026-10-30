// The operator surfaces' side of the task history (ADR-0066, spec "Surfaces"): the console's
// `GET /api/history` and Telegram's `/find` read the same query fields — the words, a project, kinds, a UTC
// date range and a limit — and both check them here, so a wrong value is refused with one reason code
// before the seam is asked. Pure.
import { QUERY_KINDS, type SearchCfg } from "./defaults";
import type { HistoryKind, HistoryQuery } from "./index";
import { dateMs } from "./tool-text";

const KNOWN = new Set<string>(QUERY_KINDS);
/** A project name is a folder name: longer input is not one. */
export const PROJECT_MAX = 128;

/** The query fields as a surface read them (strings, not yet checked). */
export interface RawQuery {
  query: string;
  project?: string;
  kinds?: string[];
  since?: string;
  until?: string;
  /** Digits only; clamped to 1…`maxLimit`. */
  limit?: string;
}

export type Checked = { ok: true; q: HistoryQuery } | { ok: false; error: string };

/** Check the fields: the query length, a known kind each, real calendar dates in order, a whole-number
 *  limit (clamped). The reason codes match the seam's own (`query_empty`, `query_too_long`,
 *  `unknown_kind`, `bad_range`) plus `bad_project`, `bad_date` and `bad_limit`. */
export function checkQuery(raw: RawQuery, cfg: Pick<SearchCfg, "maxQueryChars" | "maxLimit">): Checked {
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  if (!query) return { ok: false, error: "query_empty" };
  if (query.length > cfg.maxQueryChars) return { ok: false, error: "query_too_long" };
  const q: HistoryQuery = { query };
  const project = raw.project?.trim();
  if (project) {
    if (project.length > PROJECT_MAX || /[\u0000-\u001f/\\]/.test(project)) return { ok: false, error: "bad_project" };
    q.project = project;
  }
  const kinds = [...new Set((raw.kinds ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))];
  if (kinds.some((k) => !KNOWN.has(k))) return { ok: false, error: "unknown_kind" };
  if (kinds.length) q.kinds = kinds as HistoryKind[];
  for (const key of ["since", "until"] as const) {
    const v = raw[key]?.trim();
    if (!v) continue;
    const ms = dateMs(v, key === "until");
    if (ms === undefined) return { ok: false, error: "bad_date" };
    q[key] = ms;
  }
  if (q.since !== undefined && q.until !== undefined && q.since > q.until) return { ok: false, error: "bad_range" };
  const limit = raw.limit?.trim();
  if (limit) {
    if (!/^\d{1,6}$/.test(limit)) return { ok: false, error: "bad_limit" };
    q.limit = Math.max(1, Math.min(cfg.maxLimit, Number(limit)));
  }
  return { ok: true, q };
}

/** The console's query string (`q`, `project`, `kinds` as a comma list, `since`, `until`, `limit`). */
export function rawFromParams(p: URLSearchParams): RawQuery {
  const opt = (k: string): string | undefined => p.get(k) ?? undefined;
  const kinds = p.get("kinds");
  return {
    query: p.get("q") ?? "",
    ...(opt("project") !== undefined ? { project: opt("project") } : {}),
    ...(kinds ? { kinds: kinds.split(",") } : {}),
    ...(opt("since") !== undefined ? { since: opt("since") } : {}),
    ...(opt("until") !== undefined ? { until: opt("until") } : {}),
    ...(opt("limit") !== undefined ? { limit: opt("limit") } : {}),
  };
}
