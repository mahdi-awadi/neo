/** The skillify producer (ADR-0044 Phase 4, spec A7): a task the operator gave one project on at least
 *  `tools.skillifyMin` different days in 30 days, with no card or skill in the catalogue that fits it, becomes
 *  one attention item: "this task repeated N times: make it a recipe or a skill?". Tasks are grouped by
 *  the word set of a brief's first line (lowercased, stop words dropped, sorted). Engine-made todos
 *  (plan steps, continuations, todos opened from an attention item) and cancelled todos are not repeats,
 *  and the same task given again on the same day (a re-queue, a side-lane re-add) counts once. The engine only
 *  counts; `→ todo` sends the item to a worker. Plain code, no AI. */
import type { AttentionDraft, Ledger } from "../ledger";
import { reconcileAll } from "../attention";
import { isContinuationBrief } from "../context-policy";
import { findSecret } from "../secret-patterns";
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
  const groups = new Map<string, { project: string; folder: string; words: string[]; line: string; days: Set<number> }>();
  for (const t of deps.ledger.operatorTodoBriefs({ since: now - WINDOW_MS, maxChars: BRIEF_CHARS })) {
    if (isContinuationBrief(t.brief)) continue;
    const first = t.brief.split("\n", 1)[0]!.trim();
    // A secret-shaped word never becomes part of a key, a title or a detail; its line is not quoted.
    const all = (first.toLowerCase().match(WORD_RE) ?? []).filter((w) => !stop.has(w));
    const words = [...new Set(all.filter((w) => !findSecret(w)))].slice(0, MAX_WORDS).sort();
    if (words.length === 0) continue;
    const line = findSecret(first) || words.length < new Set(all).size ? "" : first;
    const k = `${t.project}\0${words.join(" ")}`;
    const g = groups.get(k) ?? { project: t.project, folder: t.folder, words, line, days: new Set<number>() };
    if (!line) g.line = "";
    g.days.add(Math.floor(t.at / DAY_MS));
    groups.set(k, g);
  }
  const out: AttentionDraft[] = [];
  for (const g of groups.values()) {
    const n = g.days.size;
    if (n < deps.cfg.skillifyMin) continue;
    // A tool, recipe or skill that already fits: nothing to suggest. `quiet`: this is not a worker's
    // search, so a miss is not recorded for the enrichment loop.
    if (deps.catalogue.find(g.words.join(" "), { project: g.project, folder: g.folder, quiet: true }).length > 0) continue;
    const quote = g.line.length > TITLE_CHARS ? g.line.slice(0, TITLE_CHARS - 1).trimEnd() + "…" : g.line;
    out.push({
      project: g.project, folder: g.folder, source: "skillify", kind: SKILLIFY_KINDS[0], key: `skillify:${g.words.join(" ")}`,
      title: `this task came back on ${n} days in 30: make it a recipe or a skill?${quote ? ` "${quote}"` : ""}`,
      detail: `the same words in todo briefs on ${n} different days since ${new Date(now - WINDOW_MS).toISOString().slice(0, 10)}: ${g.words.join(" ")}`,
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
