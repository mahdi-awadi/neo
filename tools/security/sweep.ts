// The nightly security sweep's bookkeeping (ADR-0024, docs/loops/security-sweep.json): which repos
// have the checks turned on (a .security/config.json, one level under a root), and which of them
// still lack a fresh nightly report. `check` is the loop's goal command: exit 0 when none is stale.
//
//   bun ~/.claude/security/sweep.ts list  --root <dir> [--root <dir>…]
//   bun ~/.claude/security/sweep.ts check --root <dir> [--max-age-hours 20]
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A night's sweep counts until the next one is due, with some slack for a slow run. */
const DEFAULT_MAX_AGE_HOURS = 20;

/** Repos one level under each root with a .security/config.json, sorted. */
export function sweepRepos(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(root, e.name, ".security", "config.json"))) out.push(join(root, e.name));
    }
  }
  return out.sort();
}

function newestNightly(repo: string): number | undefined {
  const dir = join(repo, ".security", "reports");
  if (!existsSync(dir)) return undefined;
  const times = readdirSync(dir)
    .filter((f) => f.startsWith("nightly-") && f.endsWith(".json"))
    .map((f) => statSync(join(dir, f)).mtimeMs);
  return times.length ? Math.max(...times) : undefined;
}

/** The repos whose newest nightly report is missing or older than `maxAgeMs`. */
export function staleRepos(repos: string[], maxAgeMs: number, now = Date.now()): string[] {
  return repos.filter((r) => {
    const t = newestNightly(r);
    return t === undefined || now - t > maxAgeMs;
  });
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const roots: string[] = [];
  let hours = DEFAULT_MAX_AGE_HOURS;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--root") roots.push(rest[++i]!);
    else if (rest[i] === "--max-age-hours") hours = Number(rest[++i]);
  }
  if (!roots.length || (cmd !== "list" && cmd !== "check")) {
    console.error("usage: sweep.ts list|check --root <dir> [--root <dir>…] [--max-age-hours n]");
    process.exit(2);
  }
  const repos = sweepRepos(roots);
  if (cmd === "list") {
    console.log(repos.join("\n"));
  } else {
    const stale = staleRepos(repos, hours * 3_600_000);
    console.log(stale.length ? `stale (${stale.length}/${repos.length}):\n${stale.join("\n")}` : `all ${repos.length} repos swept`);
    process.exit(stale.length ? 1 : 0);
  }
}
