// The operator surfaces' side of the task history (ADR-0067, spec "Surfaces"): the console's
// `GET /api/history` and Telegram's `/find` read the same query fields — the words, a project, kinds, a UTC
// date range and a limit — and both check them here, so a wrong value is refused with one reason code
// before the seam is asked. The Telegram replies are built here too: at most 4,096 characters, numbers
// left-to-right in Arabic lines. Pure.
import { RTL_SCRIPT, numbersLtrText } from "../bidi";
import { isProjectName, PROJECT_MAX, QUERY_KINDS, type SearchCfg } from "./defaults";
import type { ForgetResult, HistoryKind, HistoryQuery, HistoryResult } from "./index";
import { dateMs, hitText, modeLine } from "./tool-text";

const KNOWN = new Set<string>(QUERY_KINDS);
export { PROJECT_MAX };

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
    if (!isProjectName(project)) return { ok: false, error: "bad_project" };
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

// ── Telegram (`/find`, `/forget`) ──────────────────────────────────────────────────────────────────
/** Telegram's limit for one message's text. */
export const TELEGRAM_MAX = 4096;
const FILTERS: Record<string, "project" | "kinds" | "since" | "until"> = { "p:": "project", "k:": "kinds", "since:": "since", "until:": "until" };

/** `/find <words> [p:<project>] [k:<kind>,…] [since:<YYYY-MM-DD>] [until:<YYYY-MM-DD>]` → the raw fields. A
 *  filter word may stand anywhere; the other words are the query. */
export function parseFindArgs(args: string): RawQuery {
  const words: string[] = [];
  const raw: Omit<RawQuery, "query"> = {};
  for (const w of args.split(/\s+/).filter(Boolean)) {
    const prefix = Object.keys(FILTERS).find((p) => w.toLowerCase().startsWith(p) && w.length > p.length);
    if (!prefix) {
      words.push(w);
      continue;
    }
    const field = FILTERS[prefix]!;
    const v = w.slice(prefix.length);
    if (field === "kinds") raw.kinds = v.split(",");
    else raw[field] = v;
  }
  return { query: words.join(" "), ...raw };
}

/** Each line with Arabic or Hebrew script keeps its numbers left-to-right (plain-text isolates). */
export const bidiLines = (text: string): string => text.split("\n").map((l) => (RTL_SCRIPT.test(l) ? numbersLtrText(l) : l)).join("\n");

/** The console link for a query: the History tab, searching it. */
export function historyLink(consoleUrl: string, query: string): string {
  return `${consoleUrl.replace(/\/+$/, "")}/#history=${encodeURIComponent(query)}`;
}

/** A `/find` answer: the mode line (when meaning search is not on), at most `limit` hits, then the console
 *  link. Never over `max` characters: fewer hits first, then the last hit cut. */
export function findReply(r: HistoryResult, o: { query: string; limit: number; consoleUrl?: string; max?: number }): string {
  if (!r.ok) {
    return r.error === "history_unreadable" ? "History is not available right now (history.db could not be opened)." : `Search refused: ${r.error ?? "unknown"}.`;
  }
  if (!r.hits.length) return bidiLines([...(r.mode.meaning === "on" ? [] : [modeLine(r.mode)]), "No past records match."].join("\n"));
  const max = o.max ?? TELEGRAM_MAX;
  const head = r.mode.meaning === "on" ? [] : [modeLine(r.mode)];
  const link = o.consoleUrl ? historyLink(o.consoleUrl, o.query) : "";
  const tail = link ? `\n${link}` : "";
  const hits = r.hits.slice(0, Math.max(1, o.limit)).map((h, i) => bidiLines(hitText(h, i + 1)));
  for (let n = hits.length; n >= 1; n--) {
    const text = [...head, ...hits.slice(0, n)].join("\n") + tail;
    if (text.length <= max) return text;
  }
  const body = [...head, hits[0]!].join("\n");
  return `${body.slice(0, Math.max(0, max - tail.length - 1))}…${tail}`;
}

/** The answer to a Forget tap. */
export function forgetReply(ref: string, r: ForgetResult): string {
  if (!r.ok) return `Not forgotten: ${r.error ?? "unknown"}.`;
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
  const pending = r.pendingPoints ? `; ${plural(r.pendingPoints, "vector")} ${r.pendingPoints === 1 ? "waits" : "wait"} for the shared index` : "";
  return `Forgot ${ref}: ${plural(r.chunks, "text chunk")} and ${plural(r.points, "vector")} removed${pending}.`;
}
