// What tool searches missed (ADR-0044 Phase 4, spec A6): the deterministic half of the `tools-enrich`
// loop. Every `tools_for` call, and every dispatch tools hint, that found no tool records a `tools_miss`
// event with the query terms only (never the brief). The engine decides nothing here by AI:
//
//   bun tools/catalogue/misses.ts check    the loop's goal: exit 0 when no miss is newer than the last
//                                          mark (nothing to do, so no worker runs); exit 1 otherwise
//   bun tools/catalogue/misses.ts list     the unhandled terms, most frequent first, with their projects
//   bun tools/catalogue/misses.ts mark (--branch <name> | --none "<why no card changes>")
//                                          the worker's last step: the misses so far are handled. A
//                                          branch must exist in the Neo repo (the engine checks it)
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
const BRANCH_RE = /^[\w][\w./-]*$/;
const USAGE = 'usage: bun tools/catalogue/misses.ts check | list | mark (--branch <name> | --none "<why>")  [--days <n ≥ 1>] [--ledger <path>]';

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
    if (a.startsWith("--")) { flags[a.slice(2)] = args[i + 1] ?? ""; i++; } else pos.push(a);
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
    return { code: 0, stdout: `${misses.length} searches found no tool since ${day(since)}. Terms, most frequent first:\n${lines.join("\n")}\n` };
  }
  // mark: only on evidence the engine checks — a branch that exists — or a stated reason.
  const branch = flags.branch;
  const none = flags.none?.trim();
  if ((branch === undefined) === (none === undefined)) return { code: 2, stdout: "give exactly one of --branch <name> or --none \"<why>\"\n" };
  if (branch !== undefined) {
    if (!BRANCH_RE.test(branch) || (deps.git ?? realGit)(NEO_ROOT, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === undefined) {
      return { code: 2, stdout: `no branch ${JSON.stringify(branch)} in the Neo repo: commit your card changes on it first\n` };
    }
  } else if (!none) return { code: 2, stdout: "--none needs the reason no card changed\n" };
  const through = misses.length ? Math.max(...misses.map((m) => m.at)) : now;
  ledger.setMeta(MARK_KEY, through, now);
  ledger.recordEvent("tools_enrich_mark", { data: { handled: misses.length, ...(branch !== undefined ? { branch } : { none }) } });
  return { code: 0, stdout: `marked ${misses.length} searches as handled${branch !== undefined ? ` (branch ${branch})` : ""}\n` };
}

if (import.meta.main) {
  const r = runMisses(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.exit(r.code);
}
