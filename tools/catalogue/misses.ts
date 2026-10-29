// What tool searches missed (ADR-0044 Phase 4, spec A6): the deterministic half of the `tools-enrich`
// loop. Every `tools_for` call, and every dispatch tools hint, that found no tool records a `tools_miss`
// event with the query terms only (never the brief). The engine decides nothing here by AI:
//
//   bun tools/catalogue/misses.ts check    the loop's goal: exit 0 when no miss is newer than the last
//                                          mark (nothing to do, so no worker runs); exit 1 otherwise
//   bun tools/catalogue/misses.ts list     the unhandled terms, most frequent first, with their projects,
//                                          and the `--through` value that names exactly what was listed
//   bun tools/catalogue/misses.ts mark --through <at> (--branch <name> | --none "<why no card changes>")
//                                          the worker's last step: the listed misses are handled. A branch
//                                          must be `chore/tools-enrich-*`, with commits beyond `dev` that
//                                          touch only docs/tools/ (the engine checks it)
//   [--days 7]  how far back the first run looks (no mark yet)   [--ledger <path>]  (default: data/ledger.db)
import { resolve } from "node:path";
import { git as realGit, type GitRunner } from "../../src/engine/git-read";
import { LEDGER_PATH, openLedger, type Ledger } from "../../src/engine/ledger";

const NEO_ROOT = resolve(import.meta.dir, "../..");
const DAY_MS = 86_400_000;
const MARK_KEY = "toolsEnrich.handledThrough";
/** How many events are read at most (the events table keeps far fewer misses than this). */
const MAX_EVENTS = 5000;
/** How many terms `list` prints. */
const TOP_TERMS = 60;
const BRANCH_RE = /^chore\/tools-enrich-[\w.-]+$/;
const INTEGRATION_BRANCH = "dev";
const CARDS_DIR = "docs/tools/";
const USAGE = 'usage: bun tools/catalogue/misses.ts check | list | mark --through <at> (--branch chore/tools-enrich-<x> | --none "<why>")  [--days <n ≥ 1>] [--ledger <path>]';

type Miss = { at: number; project: string; terms: string[] };

/** The misses after the last mark (or, before the first mark, in the last `days` days), oldest first. */
function unhandled(ledger: Ledger, days: number, now: number): { since: number; misses: Miss[] } {
  const mark = ledger.getMeta(MARK_KEY)?.value;
  const since = typeof mark === "number" ? mark : now - days * DAY_MS;
  const misses: Miss[] = [];
  for (const e of ledger.listEvents({ kind: "tools_miss", limit: MAX_EVENTS })) {
    const list = e.data?.terms;
    if (e.at <= since || !Array.isArray(list)) continue;
    misses.push({ at: e.at, project: typeof e.data?.project === "string" ? e.data.project : "?", terms: list.filter((x): x is string => typeof x === "string") });
  }
  return { since, misses: misses.reverse() };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function runMisses(args: string[], deps: { git?: GitRunner; now?: () => number } = {}): { code: number; stdout: string } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return { code: 2, stdout: `${a} needs a value\n${USAGE}\n` };
      flags[a.slice(2)] = v;
      i++;
    } else pos.push(a);
  }
  const days = flags.days === undefined ? 7 : Number(flags.days);
  const cmd = pos[0];
  if (!Number.isInteger(days) || days < 1 || !["check", "list", "mark"].includes(cmd ?? "")) return { code: 2, stdout: `${USAGE}\n` };
  const now = (deps.now ?? Date.now)();
  const ledger = openLedger(flags.ledger || resolve(NEO_ROOT, LEDGER_PATH));
  const { since, misses } = unhandled(ledger, days, now);

  if (cmd === "check") {
    return misses.length === 0
      ? { code: 0, stdout: "" }
      : { code: 1, stdout: `${misses.length} searches found no tool since ${day(since)}\n` };
  }
  if (cmd === "list") {
    if (misses.length === 0) return { code: 0, stdout: `no search missed since ${day(since)}\n` };
    const terms = new Map<string, { n: number; projects: Set<string> }>();
    for (const m of misses) {
      for (const t of new Set(m.terms)) {
        const s = terms.get(t) ?? { n: 0, projects: new Set<string>() };
        s.n++;
        s.projects.add(m.project);
        terms.set(t, s);
      }
    }
    const lines = [...terms]
      .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
      .slice(0, TOP_TERMS)
      .map(([t, s]) => `${t} · ${s.n} · ${[...s.projects].sort().join(", ")}`);
    const through = Math.max(...misses.map((m) => m.at));
    return { code: 0, stdout: `${misses.length} searches found no tool since ${day(since)}. Terms, most frequent first:\n${lines.join("\n")}\nWhen done: misses.ts mark --through ${through} …\n` };
  }
  // mark: only on evidence the engine checks — a card branch that really changed cards — or a stated reason,
  // and only through what `list` printed, so a miss that came later is still unhandled.
  const through = Number(flags.through);
  if (!Number.isInteger(through) || through <= 0 || through > now) return { code: 2, stdout: "give --through <at>, the value `misses.ts list` printed\n" };
  const branch = flags.branch;
  const none = flags.none?.trim();
  if ((branch === undefined) === (flags.none === undefined)) return { code: 2, stdout: "give exactly one of --branch <name> or --none \"<why>\"\n" };
  if (branch !== undefined) {
    const why = branchEvidence(branch, deps.git ?? realGit);
    if (why) return { code: 2, stdout: `${why}\n` };
  } else if (!none) return { code: 2, stdout: "--none needs the reason no card changed\n" };
  const handled = misses.filter((m) => m.at <= through).length;
  ledger.setMeta(MARK_KEY, through, now);
  ledger.recordEvent("tools_enrich_mark", { data: { handled, through, ...(branch !== undefined ? { branch } : { none }) } });
  return { code: 0, stdout: `marked ${handled} searches as handled${branch !== undefined ? ` (branch ${branch})` : ""}\n` };
}

/** Why a branch is not evidence of card work, or "" when it is: a `chore/tools-enrich-*` branch with
 *  commits beyond `dev`, every changed file under docs/tools/. */
function branchEvidence(branch: string, git: GitRunner): string {
  if (!BRANCH_RE.test(branch)) return `the branch must be chore/tools-enrich-<something>, not ${JSON.stringify(branch)}`;
  if (git(NEO_ROOT, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === undefined) return `no branch ${branch} in the Neo repo: commit your card changes on it first`;
  const range = `${INTEGRATION_BRANCH}...refs/heads/${branch}`;
  const files = (git(NEO_ROOT, ["diff", "--name-only", range]) ?? "").split("\n").filter(Boolean);
  if (files.length === 0) return `${branch} changes nothing beyond ${INTEGRATION_BRANCH}`;
  const outside = files.filter((f) => !f.startsWith(CARDS_DIR));
  if (outside.length) return `${branch} changes files outside ${CARDS_DIR}: ${outside.slice(0, 5).join(", ")}`;
  return "";
}

if (import.meta.main) {
  const r = runMisses(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.exit(r.code);
}
