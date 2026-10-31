// The upgrade guard (ADR-0072): one run's stateful adapter around the pure judge of order-size.ts. It builds a
// `Touch` from each tool call, measures the run's own change with git at commit points and at the run's end,
// and is a steer in the governor hook (the seam of the plan hold and the context checkpoint): it only ever
// DENIES a call or has no opinion, and it only moves the order up. Reads files and git (the bounded sync
// `git()` of git-read.ts); no ledger, no network. Created by dispatch like createPlanWatch.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gitCall, realish, walkBash, writeTargets } from "./bash-walk";
import { git as realGit, type GitRunner } from "./git-read";
import type { RunBaseline } from "./commit-finish";
import type { LaneKind } from "./lanes";
import { faults } from "./fault";
import { READ_TOOLS, WRITE_TOOLS } from "./plan-watch";
import {
  GUARD_ERROR_TEXT,
  JUST_FIX_TEXT,
  ORDER_SIZES,
  compileSizeRules,
  judgeTouch,
  measureFailedText,
  planFirstSteer,
  plannerDenyText,
  serviceOf,
  sideStopSteer,
  upSteer,
  type ChangeSoFar,
  type OrderSize,
  type SizeRules,
  type SizesCfg,
  type SizeUp,
  type Touch,
} from "./order-size";

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
    // `added\tdeleted\tpath` — the path may itself hold a tab, so split at the first two only.
    const t = tokens[i]!;
    const a = t.indexOf("\t"), d = a < 0 ? -1 : t.indexOf("\t", a + 1);
    if (d < 0) continue;
    const n = num(t.slice(0, a)) + num(t.slice(a + 1, d));
    const path = t.slice(d + 1);
    if (path) {
      lines.set(path, (lines.get(path) ?? 0) + n);
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

// ── One call's touch (spec §5.1) ────────────────────────────────────────────────────────────────────────────

/** The git subcommands that are a commit point (spec §5.3): the guard measures with git before them. */
const COMMIT_POINT = /^(commit|merge|cherry-pick|revert|am|rebase)$/;

/** A text's lines, for the multiset difference (a last newline ends the last line, it adds none). */
const linesOf = (t: string): string[] => (t ? t.replace(/\n$/, "").split("\n") : []);

/** The multiset line difference of two texts: the lines added plus the lines removed (as numstat counts). */
function lineDiff(before: string, after: string): number {
  const left = new Map<string, number>();
  for (const l of linesOf(before)) left.set(l, (left.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of linesOf(after)) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of left.values()) removed += n;
  return added + removed;
}

/** How often `needle` occurs in `hay` (not overlapping). */
function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What one tool call changes or runs, from its input (spec §5.1). Paths are folder-relative; a path
 *  outside the folder is not the project's change and is dropped. Bash writes count 0 lines (the commit
 *  measure counts them). `service` is the guard's to set. */
export function touchOf(tool: string, input: unknown, o: { folder: string; files?: GuardFiles }): Touch {
  const files = o.files ?? realGuardFiles;
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const root = realish(resolve(o.folder));
  const paths = new Map<string, { path: string; lines: number; created: boolean }>();
  const touch: Touch = { paths: [], commands: [], commit: false, planner: false };
  /** Count the absolute path `abs` with `lines(abs)` changed lines; outside the folder adds nothing. */
  const add = (abs: string, lines: (abs: string) => number): void => {
    const rel = relative(root, realish(abs));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
    const had = paths.get(rel);
    if (had) had.lines += lines(abs);
    else paths.set(rel, { path: rel, lines: lines(abs), created: !files.exists(abs) });
  };
  const at = (p: unknown): string | undefined => (typeof p === "string" && p ? resolve(o.folder, p) : undefined);
  const old = (abs: string) => files.read(abs, READ_MAX_BYTES) ?? "";
  /** One Edit's lines: the multiset difference × the matches when it replaces all. */
  const editLines = (text: string, e: Record<string, unknown>): number => {
    const d = lineDiff(str(e.old_string), str(e.new_string));
    return e.replace_all === true ? d * Math.max(1, occurrences(text, str(e.old_string))) : d;
  };

  const target = WRITE_TOOLS[tool] ? at(inp[WRITE_TOOLS[tool]]) : undefined;
  if (tool === "Write" && target) add(target, (abs) => lineDiff(old(abs), str(inp.content)));
  else if (tool === "Edit" && target) add(target, (abs) => editLines(old(abs), inp));
  else if (tool === "MultiEdit" && target) {
    const edits = Array.isArray(inp.edits) ? inp.edits : [];
    add(target, (abs) => {
      const text = old(abs);
      return edits.reduce((n: number, e: unknown) => n + editLines(text, (e && typeof e === "object" ? e : {}) as Record<string, unknown>), 0);
    });
  } else if (tool === "NotebookEdit" && target) add(target, () => linesOf(str(inp.new_source)).length);
  else if (tool === "Bash" && typeof inp.command === "string") {
    walkBash(inp.command, o.folder, (seg) => {
      touch.commands.push(seg.words.slice(0, 4).join(" "));
      // `sed -i SCRIPT FILE…`: writeTargets names every word; the script (no -e/-f given) is not a file.
      const script = seg.words[0] === "sed" && !seg.words.some((w) => /^(?:-e|-f|--expression|--file)/.test(w)) ? seg.words.slice(1).find((w) => !w.startsWith("-")) : undefined;
      for (const t of [...seg.redirects, ...writeTargets(seg).filter((w) => w !== script)]) add(resolve(seg.cwd, t), () => 0);
      const g = gitCall(seg);
      if (g && COMMIT_POINT.test(g.sub)) touch.commit = true;
      if (g && (g.sub === "rm" || g.sub === "mv")) for (const a of g.args) if (!a.startsWith("-")) add(resolve(g.repo, a), () => 0);
      return undefined;
    });
  } else if ((tool === "Agent" || tool === "Task") && inp.subagent_type === "planner") touch.planner = true;
  touch.paths = [...paths.values()];
  return touch;
}

// ── The guard (spec §5.3, §5.4) ─────────────────────────────────────────────────────────────────────────────

export interface SizeGuardOpts {
  size: OrderSize;
  folder: string;
  project: string;
  /** A side lane: a move to big stops it (there is no plan gate there). */
  side?: LaneKind;
  cfg: SizesCfg;
  planPaths: string[];
  /** The run's baseline (runBaseline). None → the folder is not in git: no commit points, the estimates only. */
  baseline?: RunBaseline;
  /** HEAD at the run's start (none in a repository with no commit yet: the empty tree). */
  startSha?: string;
  /** A plan this run held is approved → plan first ends. */
  planApproved: () => boolean;
  /** One move up (dispatch: the event, the operator's line, the dispatcher's note, the todo row). */
  onUp: (up: SizeUp) => void;
  now?: () => number;
  git?: GitRunner;
  files?: GuardFiles;
}

/** What the run's end says (spec §5.3 "At the run's end"). */
export interface SizeEnd {
  size: OrderSize;
  /** The run ended in plan first with no plan of its own awaiting approval: the todo runs again, as big. */
  requeue: boolean;
  /** The final measure; absent outside git or when git could not be read. */
  measured?: ChangeMeasure;
  /** A move the final measure found, after nothing could be stopped. */
  late?: SizeUp;
}

export interface SizeGuard {
  size(): OrderSize;
  /** The steer: a deny reason or undefined (no opinion). It never throws and never allows. */
  steer(tool: string, input: unknown): string | undefined;
  onToolUse(id: string | undefined, tool: string, input: unknown): void;
  onToolResult(id: string | undefined, isError: boolean): void;
  /** Another part of the engine found the order bigger (the plan gate held a plan). No deny. */
  raise(to: OrderSize, facts: Pick<SizeUp, "rule"> & Partial<SizeUp>): void;
  /** Moved to big in the main lane, and its plan is not approved yet. */
  planFirst(): boolean;
  /** The run ended: measure, record a late move, say whether the todo runs again as big. */
  end(o: { planAwaiting: boolean }): SizeEnd;
}

const rank = (s: OrderSize) => ORDER_SIZES.indexOf(s);
const EMPTY: ChangeSoFar = { files: new Map(), services: new Set() };
/** Steer-built touches kept for the stream's onToolUse (the hook and the stream may come in either order). */
const SEEN_MAX = 64;
const MARKDOWN = new Bun.Glob("**/*.md");

export function createSizeGuard(o: SizeGuardOpts): SizeGuard {
  const now = o.now ?? Date.now;
  const files = o.files ?? realGuardFiles;
  const rules = compileSizeRules(o.cfg, o.project, o.planPaths);
  const from = o.size;
  let size = o.size;
  let last: SizeUp | undefined;
  let planFirst = false;
  let sideStop = false;
  let sofar = { files: new Map<string, number>(), services: new Set<string>() };
  const pending = new Map<string, Touch>();
  const seen = new Map<string, Touch>();
  const ctx = { project: o.project, folder: o.folder };

  const hasFile = (rel: string) => files.exists(join(o.folder, rel));
  const ignored = (p: string) => rules.ignore.some((g) => g.match(p));
  const key = (tool: string, input: unknown) => `${tool}\0${JSON.stringify(input) ?? ""}`;
  const build = (tool: string, input: unknown): Touch => {
    const t = touchOf(tool, input, { folder: o.folder, files });
    for (const p of t.paths) {
      const service = serviceOf(p.path, rules, hasFile);
      if (service) p.service = service;
    }
    return t;
  };
  const measure = (): ChangeMeasure | undefined =>
    o.baseline ? measureRunChange({ folder: o.folder, startSha: o.startSha, baseline: o.baseline, rules, git: o.git, files }) : undefined;
  /** The measured change as one touch for the judge. The no-new-files paths are left out: those are the
   *  steer's to deny at the call, never a size. */
  const measuredPaths = (m: ChangeMeasure): Touch["paths"] =>
    [...m.files]
      .filter(([p]) => !rules.noNewFiles.some((g) => g.match(p)))
      .map(([p, lines]) => {
        const service = serviceOf(p, rules, hasFile);
        return { path: p, lines, created: m.created.has(p), ...(service ? { service } : {}) };
      });
  /** Move up to `to` (never down); `from` stays the size the run started at. Calls onUp once a move. */
  const move = (to: OrderSize, facts: Omit<SizeUp, "from" | "to" | "at">): SizeUp | undefined => {
    if (rank(to) <= rank(size)) return undefined;
    size = to;
    const up: SizeUp = { ...facts, from, to, at: now() };
    last = up;
    faults.guard("sizeGuard.onUp", () => o.onUp(up), ctx);
    return up;
  };
  /** In plan first, these run: reads, Neo's and codebase-memory's tools, helper agents, Markdown files. */
  const planFirstLets = (tool: string, input: unknown): boolean => {
    if (READ_TOOLS.has(tool) || tool.startsWith("mcp__neo__") || tool.startsWith("mcp__codebase-memory__")) return true;
    if (tool === "Agent" || tool === "Task") return true;
    if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") return false;
    const file = (input && typeof input === "object" ? (input as Record<string, unknown>).file_path : undefined);
    return typeof file === "string" && MARKDOWN.match(relative(o.folder, resolve(o.folder, file)));
  };

  const judge = (tool: string, input: unknown): string | undefined => {
    if (sideStop) return READ_TOOLS.has(tool) ? undefined : sideStopSteer(last!);
    if (planFirst) {
      if (!o.planApproved()) return planFirstLets(tool, input) ? undefined : planFirstSteer(last!);
      planFirst = false;
    }
    if (size === "big") return undefined;
    const touch = build(tool, input);
    seen.delete(key(tool, input));
    seen.set(key(tool, input), touch);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);

    let judged;
    if (touch.commit && o.baseline) {
      // A commit point: the exact measure replaces the estimate. Never let through without one.
      const m = measure();
      if (!m) return measureFailedText("git could not be read", size);
      sofar = { files: m.files, services: m.services };
      const measured = measuredPaths(m);
      const own = touch.paths.filter((p) => !m.files.has(p.path));
      judged = judgeTouch(size, EMPTY, { ...touch, paths: [...measured, ...own] }, rules);
    } else {
      judged = judgeTouch(size, sofar, touch, rules);
    }
    if (judged.kind === "ok") return undefined;
    if (judged.kind === "deny") return judged.why === "planner" ? plannerDenyText(size) : JUST_FIX_TEXT;
    const up = move(judged.to, judged.up)!;
    if (up.to === "big" && o.side) {
      sideStop = true;
      return sideStopSteer(up);
    }
    if (up.to === "big") planFirst = true;
    return upSteer(up, o.cfg);
  };

  return {
    size: () => size,
    steer(tool, input) {
      // Closed on error, unlike the hook's open path for a throwing steer (spec §5.4).
      try {
        return judge(tool, input);
      } catch (err) {
        faults.report("sizeGuard", err, ctx);
        return GUARD_ERROR_TEXT;
      }
    },
    onToolUse(id, tool, input) {
      if (!id || size === "big") return;
      faults.guard("sizeGuard.onToolUse", () => {
        const touch = seen.get(key(tool, input)) ?? build(tool, input);
        if (touch.paths.length) pending.set(id, touch);
      }, ctx);
    },
    onToolResult(id, isError) {
      const touch = id ? pending.get(id) : undefined;
      if (!touch) return;
      pending.delete(id!);
      if (isError) return; // a failed call changed nothing
      for (const p of touch.paths) {
        if (ignored(p.path)) continue;
        sofar.files.set(p.path, (sofar.files.get(p.path) ?? 0) + p.lines);
        if (p.service) sofar.services.add(p.service);
      }
    },
    raise(to, facts) {
      faults.guard("sizeGuard.raise", () => {
        const up = move(to, facts);
        if (up?.to === "big" && o.side) sideStop = true;
      }, ctx);
    },
    planFirst: () => planFirst,
    end({ planAwaiting }) {
      // An approved plan ends plan first even when no call came after it (Approve & build runs the build).
      const requeue = () => planFirst && !planAwaiting && !(faults.guard("sizeGuard.planApproved", o.planApproved, ctx) ?? false);
      try {
        const measured = measure();
        let late: SizeUp | undefined;
        if (measured && size !== "big") {
          const j = judgeTouch(size, EMPTY, { paths: measuredPaths(measured), commands: [], commit: false, planner: false }, rules);
          if (j.kind === "up") late = move(j.to, { ...j.up, late: true });
        }
        return { size, requeue: requeue(), ...(measured ? { measured } : {}), ...(late ? { late } : {}) };
      } catch (err) {
        faults.report("sizeGuard", err, ctx);
        return { size, requeue: requeue() };
      }
    },
  };
}
