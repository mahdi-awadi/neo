/** The skillify producer (ADR-0044 Phase 4, spec A7): a task the operator gave one project at least
 *  `tools.skillifyMin` times in 30 days, with no card or skill in the catalogue that fits it, becomes
 *  one attention item: "this task repeated N times: make it a recipe or a skill?". Tasks are grouped by
 *  the word set of a brief's first line (lowercased, stop words dropped, sorted). Engine-made todos
 *  (plan steps, continuations, todos opened from an attention item) are not repeats. The engine only
 *  counts; `→ todo` sends the item to a worker. Plain code, no AI. */
import type { AttentionDraft, Ledger } from "../ledger";
import { reconcileAll } from "../attention";
import { isContinuationBrief } from "../context-policy";
import type { Catalogue, ToolsCfg } from "../tools-catalogue";

export const SKILLIFY_KINDS = ["skillify_repeat"] as const;

const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS;
/** How much of a brief is read: its first line is all that is grouped. */
const BRIEF_CHARS = 400;
/** A group key holds at most this many words (spec: queries use at most 24 terms). */
const MAX_WORDS = 24;
const TITLE_CHARS = 80;
const WORD_RE = /[\p{L}\p{N}]+/gu;

export interface SkillifyDeps {
  ledger: Pick<Ledger, "operatorTodoBriefs">;
  catalogue: Pick<Catalogue, "find">;
  cfg: Pick<ToolsCfg, "skillifyMin" | "stopWords">;
}

/** What repeats now, as drafts (one per project and word set). */
export function skillifyDrafts(deps: SkillifyDeps, now: number): AttentionDraft[] {
  const stop = new Set(deps.cfg.stopWords.map((w) => w.toLowerCase()));
  const groups = new Map<string, { project: string; folder: string; words: string[]; line: string; n: number }>();
  for (const t of deps.ledger.operatorTodoBriefs({ since: now - WINDOW_MS, maxChars: BRIEF_CHARS })) {
    if (isContinuationBrief(t.brief)) continue;
    const line = t.brief.split("\n", 1)[0]!.trim();
    const words = [...new Set((line.toLowerCase().match(WORD_RE) ?? []).filter((w) => !stop.has(w)))].slice(0, MAX_WORDS).sort();
    if (words.length === 0) continue;
    const k = `${t.project}\0${words.join(" ")}`;
    const g = groups.get(k);
    if (g) g.n++;
    else groups.set(k, { project: t.project, folder: t.folder, words, line, n: 1 });
  }
  const out: AttentionDraft[] = [];
  for (const g of groups.values()) {
    if (g.n < deps.cfg.skillifyMin) continue;
    // A tool, recipe or skill that already fits: nothing to suggest. `quiet`: this is not a worker's
    // search, so a miss is not recorded for the enrichment loop.
    if (deps.catalogue.find(g.words.join(" "), { project: g.project, folder: g.folder, quiet: true }).length > 0) continue;
    const quote = g.line.length > TITLE_CHARS ? g.line.slice(0, TITLE_CHARS - 1).trimEnd() + "…" : g.line;
    out.push({
      project: g.project, folder: g.folder, source: "skillify", kind: SKILLIFY_KINDS[0], key: `skillify:${g.words.join(" ")}`,
      title: `this task repeated ${g.n} times in 30 days: make it a recipe or a skill? "${quote}"`,
      detail: `the same words in ${g.n} todo briefs since ${new Date(now - WINDOW_MS).toISOString().slice(0, 10)}: ${g.words.join(" ")}`,
      severity: "low",
    });
  }
  return out;
}

/** The heartbeat entry: runs the producer at most once per `everyMs` (default a day) and reconciles its
 *  drafts, so a task that stops repeating, or gets a tool, resolves its item. */
export function skillifyTick(deps: Omit<SkillifyDeps, "ledger"> & { ledger: Ledger; keepResolvedMs: number; everyMs?: number }): (now: number) => void {
  let last: number | undefined;
  return (now) => {
    if (last !== undefined && now - last < (deps.everyMs ?? DAY_MS)) return;
    last = now;
    reconcileAll(deps.ledger, "skillify", skillifyDrafts(deps, now), now, { keepResolvedMs: deps.keepResolvedMs });
  };
}
