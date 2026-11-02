// The verification policy (plan 2026-11-02 W1.2, ADR-0073): which commands prove a project's work and
// which files those commands depend on, FROZEN at dispatch start. A worker may edit `.neo/checks.json`
// or `package.json` scripts during its run; the gate still runs the policy frozen before the run, so a
// worker can never change the gate of the run that makes the change (review focus 1). A changed policy
// shows as a difference against the frozen hashes and takes effect for later dispatches. Deterministic:
// file reads and sha256, no git, no AI.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

/** The project's declaration, repo-relative. */
export const CHECKS_FILE = ".neo/checks.json";

/** Files that commonly change what a check does, hashed when they exist (a `bun test` is only what
 *  `package.json`'s scripts and `bunfig.toml` make it). */
export const DEFAULT_POLICY_DEPENDENCIES = [
  CHECKS_FILE,
  "package.json",
  "bunfig.toml",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.ts",
  "jest.config.js",
  "go.mod",
  "Makefile",
  "pyproject.toml",
  "setup.cfg",
  "Cargo.toml",
];

export const CHECKS_LIMITS = { checks: 20, args: 40, argChars: 400 } as const;

export interface ChecksFile {
  /** Each check is one argv (never a shell string): `[["bun", "test"], ["bunx", "tsc", "--noEmit"]]`. */
  checks?: string[][];
  /** Extra repo-relative files the checks depend on (hashed into the policy). */
  dependsOn?: string[];
  /** W1.10: an engine-owned held-out suite applies to this project. */
  heldOut?: boolean;
}

export interface ResolvedChecks {
  checks: string[][];
  /** Where the checks came from: the file, a dispatch override, or nothing declared. */
  source: "file" | "override" | "none";
  /** Repo-relative files whose content is part of the policy (existing ones only). */
  dependencies: string[];
  /** What was wrong with the declaration (a bad file is reported, never silently treated as "none"). */
  problems: string[];
  heldOut: boolean;
}

/** Read the project's checks (or take the dispatch's override), and list the files they depend on. */
export function resolveChecks(folder: string, override?: string[][]): ResolvedChecks {
  const problems: string[] = [];
  let declared: ChecksFile = {};
  let source: ResolvedChecks["source"] = "none";
  const file = join(folder, CHECKS_FILE);
  if (override) {
    declared = { checks: override };
    source = "override";
  } else if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) problems.push(`${CHECKS_FILE} is not an object`);
      else declared = parsed as ChecksFile;
      source = "file";
    } catch (e) {
      problems.push(`${CHECKS_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      source = "file";
    }
  }

  const checks: string[][] = [];
  const raw = declared.checks;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) problems.push("`checks` must be an array of argv arrays");
    else {
      for (const [i, c] of raw.entries()) {
        if (!Array.isArray(c) || c.length === 0 || c.some((a) => typeof a !== "string" || !a.trim())) {
          problems.push(`checks[${i}] must be a non-empty array of strings`);
          continue;
        }
        if (c.length > CHECKS_LIMITS.args) problems.push(`checks[${i}] has ${c.length} arguments; at most ${CHECKS_LIMITS.args}`);
        if (c.some((a) => a.length > CHECKS_LIMITS.argChars)) problems.push(`checks[${i}] has an argument over ${CHECKS_LIMITS.argChars} characters`);
        checks.push(c.map((a) => a.trim()));
      }
      if (checks.length > CHECKS_LIMITS.checks) problems.push(`${checks.length} checks declared; at most ${CHECKS_LIMITS.checks}`);
    }
  }

  const deps = new Set<string>();
  for (const p of DEFAULT_POLICY_DEPENDENCIES) if (isFile(folder, p)) deps.add(p);
  for (const p of declared.dependsOn ?? []) {
    if (typeof p !== "string" || !p.trim()) continue;
    if (!safeRelative(p)) { problems.push(`dependsOn entry "${p}" must be a repo-relative path`); continue; }
    if (isFile(folder, p)) deps.add(normalize(p));
    else problems.push(`dependsOn entry "${p}" does not exist`);
  }
  // A check that names a script in the repo (`sh scripts/test.sh`, `bun run tools/check.ts`): the script is policy too.
  for (const c of checks) for (const a of c) if (/\.(sh|bash|ts|js|mjs|cjs|py|rb)$/.test(a) && safeRelative(a) && isFile(folder, a)) deps.add(normalize(a));

  return { checks: checks.slice(0, CHECKS_LIMITS.checks), source, dependencies: [...deps].sort(), problems, heldOut: declared.heldOut === true };
}

/** A policy frozen for one dispatch: the checks and the sha256 of every dependency, plus one hash
 *  over all of it. Stored on the order at start; the gate compares the folder against it at the end. */
export interface FrozenPolicy {
  hash: string;
  checks: string[][];
  /** repo-relative path → sha256 of its content at freeze time */
  files: Record<string, string>;
  source: ResolvedChecks["source"];
  heldOut: boolean;
  frozenAt: number;
}

export function freezePolicy(folder: string, resolved: ResolvedChecks, now: number = Date.now()): FrozenPolicy {
  const files: Record<string, string> = {};
  for (const p of resolved.dependencies) {
    const h = fileHash(join(folder, p));
    if (h) files[p] = h;
  }
  const hash = createHash("sha256").update(JSON.stringify({ checks: resolved.checks, files })).digest("hex");
  return { hash, checks: resolved.checks, files, source: resolved.source, heldOut: resolved.heldOut, frozenAt: now };
}

/** Which policy files differ from the frozen hashes now: changed, deleted, or newly declared. */
export function policyChanges(folder: string, frozen: FrozenPolicy): string[] {
  const changed: string[] = [];
  for (const [p, h] of Object.entries(frozen.files)) {
    const nowHash = fileHash(join(folder, p));
    if (nowHash !== h) changed.push(p);
  }
  // A checks file that appeared during the run is a policy change too.
  if (!(CHECKS_FILE in frozen.files) && isFile(folder, CHECKS_FILE)) changed.push(CHECKS_FILE);
  return changed.sort();
}

/** One line for a brief or a result: what the gate will run. */
export function checksLine(r: Pick<ResolvedChecks, "checks" | "source">): string {
  if (r.checks.length === 0) return "no checks declared";
  return `${r.checks.length} check${r.checks.length === 1 ? "" : "s"} (${r.source}): ${r.checks.map((c) => c.join(" ")).join(" · ")}`;
}

function isFile(folder: string, rel: string): boolean {
  try {
    return statSync(join(folder, rel)).isFile();
  } catch {
    return false;
  }
}

function fileHash(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Repo-relative and never climbing out of the folder. */
function safeRelative(p: string): boolean {
  if (isAbsolute(p)) return false;
  const n = normalize(p);
  return !n.startsWith("..") && !n.includes("/../");
}
