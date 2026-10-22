// The waiting sweep's CLI (ADR-0045) — the deterministic half of the `waiting-sweep` loop. The engine
// decides nothing here by AI: `check` is the loop's goal, and a worker uses `list`, `close` and `keep`
// to judge the decisions whose repository moved. A close is accepted only on evidence the engine
// checks (a commit or a tracked file newer than the question).
//
//   bun tools/threads/sweep.ts check                     exit 0 + the reminder (only when it changed);
//                                                        exit 1 when decisions need judging
//   bun tools/threads/sweep.ts list                      the decisions to judge, with their repo's commits
//   bun tools/threads/sweep.ts close <id> (--commit <sha> | --file <path>) --reason "<why it is done>"
//   bun tools/threads/sweep.ts keep <id> --ask "<one line: what the operator must decide or give>"
//   [--ledger <path>]   (default: the engine's data/ledger.db)
//
// It writes the ledger from its own process, like tools/create-loop.ts. It cannot see live
// sessions, so a thread a session is still working may show `done` until that session's next line.
import { resolve } from "node:path";
import { loadConfig } from "../../src/config";
import { git } from "../../src/engine/git-read";
import { LEDGER_PATH, openLedger } from "../../src/engine/ledger";
import { createRegistry } from "../../src/engine/registry";
import { createTrace } from "../../src/engine/trace";
import { check, closeWithEvidence, keepJudged, waitingDecisions, needsJudging, DEFAULT_WAITING_SWEEP_CFG, type Judged, type SweepDeps } from "../../src/engine/waiting-sweep";

const NEO_ROOT = resolve(import.meta.dir, "../..");
const USAGE = "usage: bun tools/threads/sweep.ts check | list | close <id> (--commit <sha> | --file <path>) --reason <text> | keep <id> --ask <text>  [--ledger <path>]";
/** Commits listed per decision for the worker to read. */
const LIST_COMMITS = 15;

/** `--flag value` pairs and the positional words. */
function parse(args: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      flags[a.slice(2)] = args[i + 1] ?? "";
      i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

function deps(ledgerPath: string): SweepDeps {
  const cfg = loadConfig(NEO_ROOT);
  const ledger = openLedger(ledgerPath);
  const trace = createTrace({ ledger, registry: createRegistry(), companyFolder: cfg.companyFolder, settleDecisions: cfg.decisionSettle?.enabled ?? true });
  return { ledger, refresh: (id) => trace.refreshThread(id), git, now: Date.now, cfg: cfg.waitingSweep ?? DEFAULT_WAITING_SWEEP_CFG, ref: (id) => trace.ref(id) };
}

/** The decisions to judge, each with its repo's commits since the question (newest first). */
function listText(d: SweepDeps): string {
  const judged = (d.ledger.getMeta("waitingSweep.judged")?.value ?? {}) as Record<string, Judged>;
  // What `check` offered this run, plus anything due now (when `list` runs before `check`).
  const now = d.now();
  const todo = waitingDecisions(d).filter((x) => judged[x.id]?.offeredAt !== undefined || needsJudging(x, judged[x.id], d.cfg, now));
  if (todo.length === 0) return "nothing to judge\n";
  const blocks = todo.map((x) => {
    const since = `@${Math.floor(x.createdAt / 1000)}`;
    const commits = (d.git(x.repo!, ["log", "--all", "--since", since, `--max-count=${LIST_COMMITS}`, "--format=%h %ad %s", "--date=short"]) ?? "").trim();
    const prev = judged[x.id] ? `\n  last judged ${new Date(judged[x.id]!.at).toISOString()}: ${judged[x.id]!.ask}` : "";
    return [
      `#${x.id.slice(0, 8)} · ${d.ref(x.threadId)} · ${x.project ?? "-"} · ${x.repo} · asked ${new Date(x.createdAt).toISOString()}${prev}`,
      `  Q: ${x.question.replace(/\s+/g, " ").trim()}`,
      `  commits since the question (newest ${LIST_COMMITS}):`,
      ...(commits ? commits.split("\n").map((l) => `    ${l}`) : ["    (none)"]),
    ].join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

/** Run one command; never throws for bad input (exit 2 + the reason). */
export function runSweep(args: string[]): { code: number; stdout: string } {
  const { pos, flags } = parse(args);
  const [cmd, id] = pos;
  const ledgerPath = flags.ledger || resolve(NEO_ROOT, LEDGER_PATH);
  if (cmd === "check") {
    const r = check(deps(ledgerPath));
    return { code: r.met ? 0 : 1, stdout: r.out ? `${r.out}\n` : "" };
  }
  if (cmd === "list") return { code: 0, stdout: listText(deps(ledgerPath)) };
  if (cmd === "close" && id) {
    const ev = flags.commit !== undefined ? { commit: flags.commit } : flags.file !== undefined ? { file: flags.file } : {};
    if (flags.commit !== undefined && flags.file !== undefined) return { code: 2, stdout: "give exactly one of --commit or --file\n" };
    const r = closeWithEvidence(deps(ledgerPath), id, ev, flags.reason ?? "");
    return r.ok ? { code: 0, stdout: `closed #${id} in ${r.thread}${r.todosCancelled.length ? `; cancelled parked todo ${r.todosCancelled.map((t) => `#${t}`).join(", ")}` : ""}\n` } : { code: 2, stdout: `${r.why}\n` };
  }
  if (cmd === "keep" && id) {
    const r = keepJudged(deps(ledgerPath), id, flags.ask ?? "");
    return r.ok ? { code: 0, stdout: `kept #${id}\n` } : { code: 2, stdout: `${r.why}\n` };
  }
  return { code: 2, stdout: `${USAGE}\n` };
}

if (import.meta.main) {
  const r = runSweep(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.exit(r.code);
}
