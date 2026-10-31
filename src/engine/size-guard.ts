// The upgrade guard (ADR-0072): one run's stateful adapter around the pure judge of order-size.ts. It measures
// the run's own change with git (at commit points and at the run's end). Reads files and git (the bounded
// sync `git()` of git-read.ts); no ledger, no network.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { git as realGit, type GitRunner } from "./git-read";
import type { RunBaseline } from "./commit-finish";
import { serviceOf, type SizeRules } from "./order-size";

/** The most of one file the guard reads (a new file's lines, a Write's old text). */
export const READ_MAX_BYTES = 2 * 1024 * 1024;

/** git's empty tree: the start of a repository that had no commit when the run began. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The file reads the guard makes — the seam tests replace. Paths are absolute. */
export interface GuardFiles {
  exists(path: string): boolean;
  /** A file's text, at most `maxBytes`; undefined when it is not a readable file. */
  read(path: string, maxBytes: number): string | undefined;
}

export const realGuardFiles: GuardFiles = {
  exists: (p) => existsSync(p),
  read: (p, max) => {
    try {
      const s = statSync(p);
      if (!s.isFile()) return undefined;
      const buf = Buffer.alloc(Math.min(s.size, max));
      const fd = openSync(p, "r");
      try {
        readSync(fd, buf, 0, buf.length, 0);
      } finally {
        closeSync(fd);
      }
      return buf.toString("utf8");
    } catch {
      return undefined;
    }
  },
};

/** A text's line count (a last line without a newline counts). */
export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
}

/** The run's change, measured with git (spec §5.3): folder-relative paths. */
export interface ChangeMeasure {
  /** Each counted file's changed lines (added + deleted; a binary file 0). */
  files: Map<string, number>;
  /** The counted files that did not exist at the start. */
  created: Set<string>;
  services: Set<string>;
  lines: number;
}

/** Parse `git diff --numstat --summary -z` output into path → changed lines, and the created paths. The
 *  numstat records are NUL-terminated (a rename: `a\td\t\0old\0new\0`); the summary lines follow the last
 *  record, newline-terminated, with repo-relative paths (`prefix` is the folder inside its repo). */
function parseDiff(out: string, prefix: string): { lines: Map<string, number>; created: Set<string> } {
  const lines = new Map<string, number>();
  const created = new Set<string>();
  const tokens = out.split("\0");
  const summary = tokens.pop() ?? "";
  const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : 0); // "-" = binary
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]!);
    if (!m) continue;
    const n = num(m[1]) + num(m[2]);
    if (m[3]) {
      lines.set(m[3], (lines.get(m[3]) ?? 0) + n);
      continue;
    }
    // A rename or copy: both paths count; the lines go to the new one.
    const from = tokens[++i], to = tokens[++i];
    if (from) lines.set(from, lines.get(from) ?? 0);
    if (to) lines.set(to, (lines.get(to) ?? 0) + n);
  }
  for (const l of summary.split("\n")) {
    const m = /^ create mode \d+ (.+)$/.exec(l);
    const path = m?.[1]?.replace(/^"(.*)"$/, "$1");
    if (path?.startsWith(prefix)) created.add(path.slice(prefix.length));
  }
  return { lines, created };
}

/** Measure the run's own change (spec §5.3): the working tree against the run's start (committed and
 *  uncommitted together) plus the untracked files (their lines read, at most 2 MB, binary = 0), minus the
 *  paths the baseline says are not the run's (dirty at the start and untouched) and the ignored paths.
 *  Undefined when git cannot read the folder — never a partial measure. */
export function measureRunChange(o: {
  folder: string;
  startSha?: string;
  baseline?: RunBaseline;
  rules: SizeRules;
  git?: GitRunner;
  files?: GuardFiles;
}): ChangeMeasure | undefined {
  const run = o.git ?? realGit;
  const files = o.files ?? realGuardFiles;
  const prefix = run(o.folder, ["rev-parse", "--show-prefix"])?.trim();
  if (prefix === undefined) return undefined;
  // check-ignore exits 0 (git returns "") when the folder is ignored: git does not track its files.
  if (run(o.folder, ["check-ignore", "-q", "."]) !== undefined) return undefined;
  const diff = run(o.folder, ["diff", "--numstat", "--summary", "-z", "--relative", o.startSha ?? EMPTY_TREE]);
  if (diff === undefined) return undefined;
  const others = run(o.folder, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (others === undefined) return undefined;

  const { lines, created } = parseDiff(diff, prefix);
  for (const p of others.split("\0").filter(Boolean)) {
    const text = files.read(join(o.folder, p), READ_MAX_BYTES);
    lines.set(p, text === undefined || text.includes("\0") ? 0 : lineCount(text));
    created.add(p);
  }

  const out: ChangeMeasure = { files: new Map(), created: new Set(), services: new Set(), lines: 0 };
  const hasFile = (rel: string) => files.exists(join(o.folder, rel));
  for (const [p, n] of lines) {
    if (o.baseline && !o.baseline.own(prefix + p)) continue;
    if (o.rules.ignore.some((g) => g.match(p))) continue;
    out.files.set(p, n);
    out.lines += n;
    if (created.has(p)) out.created.add(p);
    const service = serviceOf(p, o.rules, hasFile);
    if (service) out.services.add(service);
  }
  return out;
}
