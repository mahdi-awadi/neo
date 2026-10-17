// Disk cleanup for this host (ADR-0040). Deterministic: the decisions below are pure functions over
// an inventory, and every command goes through an injected shell, so tests never touch the host.
//
//   Tier A — rebuildable, removed automatically: dangling images; unused images older than the
//            minimum age; old build cache; containers stopped longer than that; the journal;
//            rotated logs; package caches; old /tmp files.
//   Tier B — irreversible, only LISTED: unused volumes, data folders of stopped database
//            containers, dumps and backups, git worktrees, big build outputs. Each has a stable
//            id; `delete --ids` removes exactly the approved ones, checked again first.
//   Never:   a running container or its volumes, anything matching a protect pattern (prod, the
//            engine's data and company folders), .env files, the security kit's pinned images.
//
//   bun cleanup.ts measure | check | run [--dry-run] | delete --ids <id,id,...>
//
// Values live in defaults.json; a host overrides them in config.json next to the installed copy.
// State (last run, Tier B list) lives in ./state.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface DiskConfig {
  mount: string;
  targetPct: number;
  alertPct: number;
  dailyHour: number;
  cooldownHours: number;
  nothingLeftBytes: number;
  minAgeDays: number;
  journalMaxSize: string;
  protect: string[];
  keepImagesFrom: string[];
  logRoots: string[];
  logSkipDirs: string[];
  tmpRoots: string[];
  tmpSkip: string[];
  /** `cwd` (relative to the kit) for tools that must run inside a project folder (bun). */
  packageCaches: Array<{ name: string; argv: string[]; cwd?: string }>;
  dumpRoots: string[];
  dumpPattern: string;
  dumpMinBytes: number;
  projectsRoot: string;
  buildOutputNames: string[];
  buildOutputMinBytes: number;
  volumeMinBytes: number;
  dbImagePattern: string;
  reportTop: number;
}

/** Runs one command (no shell). A missing program is code 127, never a throw. */
export type Sh = (argv: string[], opts?: { cwd?: string }) => { code: number; out: string };

export const realSh: Sh = (argv, opts) => {
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", cwd: opts?.cwd });
    return { code: r.exitCode ?? 1, out: r.stdout.toString() + (r.exitCode ? r.stderr.toString() : "") };
  } catch {
    return { code: 127, out: `${argv[0]}: not found` };
  }
};

const DAY = 86_400_000;
const tilde = (p: string, home: string) => p.replace(/^~(?=\/|$)/, home);

/** defaults.json, overridden key by key by an optional config.json in the same folder. */
export function loadDiskConfig(kitDir: string, home = homedir()): DiskConfig {
  const defaults = JSON.parse(readFileSync(join(kitDir, "defaults.json"), "utf8")) as DiskConfig;
  const local = join(kitDir, "config.json");
  const over = existsSync(local) ? (JSON.parse(readFileSync(local, "utf8")) as Partial<DiskConfig>) : {};
  const cfg = { ...defaults, ...over };
  return {
    ...cfg,
    keepImagesFrom: cfg.keepImagesFrom.map((p) => tilde(p, home)),
    packageCaches: cfg.packageCaches.map((p) => (p.cwd ? { ...p, cwd: resolve(kitDir, tilde(p.cwd, home)) } : p)),
  };
}

/** Any of `texts` (a name, tag, path, compose project) matches a protect pattern, or names a .env file. */
export function isProtected(cfg: DiskConfig, ...texts: Array<string | undefined>): boolean {
  return texts.some((t) => !!t && (cfg.protect.some((p) => new RegExp(p, "i").test(t)) || /^\.env/.test(basename(t))));
}

/** The digests pinned in an images.env (`NAME=repo@sha256:…`). */
export function parseKeepDigests(text: string): Set<string> {
  return new Set([...text.matchAll(/^\s*\w+=\S*@(sha256:[0-9a-f]+)\s*$/gm)].map((m) => m[1]!));
}

// ---- inventory ---------------------------------------------------------------------------------

export interface ImageInfo {
  id: string;
  tags: string[];
  digests: string[];
  created: number;
}
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  imageName: string;
  project?: string;
  running: boolean;
  status: string;
  /** When it last stopped (ms); 0 when it never ran. */
  finishedAt: number;
  volumes: string[];
  binds: string[];
}
export interface VolumeInfo {
  name: string;
  created: number;
  project?: string;
  bytes: number;
}

const time = (s: unknown) => {
  const t = Date.parse(String(s ?? ""));
  return Number.isFinite(t) && t > Date.parse("2000-01-01") ? t : 0;
};
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const json = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** docker's human sizes ("3.2GB", "512kB", "0B") in bytes; docker uses powers of 1000. */
export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([kMGTP]?)B$/i.exec(s.trim());
  if (!m) return 0;
  const exp = { "": 0, k: 1, m: 2, g: 3, t: 4, p: 5 }[m[2]!.toLowerCase() as "" | "k" | "m" | "g" | "t" | "p"];
  return Math.round(Number(m[1]) * 1000 ** exp);
}

export function images(sh: Sh): ImageInfo[] {
  const ids = [...new Set(lines(sh(["docker", "image", "ls", "-aq", "--no-trunc"]).out))];
  if (!ids.length) return [];
  const raw = json<Array<{ Id: string; RepoTags?: string[]; RepoDigests?: string[]; Created?: string }>>(sh(["docker", "image", "inspect", ...ids]).out, []);
  return raw.map((i) => ({ id: i.Id, tags: (i.RepoTags ?? []).filter((t) => t !== "<none>:<none>"), digests: i.RepoDigests ?? [], created: time(i.Created) }));
}

export function containers(sh: Sh): ContainerInfo[] {
  const ids = lines(sh(["docker", "ps", "-aq", "--no-trunc"]).out);
  if (!ids.length) return [];
  type Raw = {
    Id: string;
    Name?: string;
    Image?: string;
    Config?: { Image?: string; Labels?: Record<string, string> | null };
    State?: { Status?: string; Running?: boolean; FinishedAt?: string };
    Mounts?: Array<{ Type?: string; Name?: string; Source?: string }>;
  };
  return json<Raw[]>(sh(["docker", "container", "inspect", ...ids]).out, []).map((c) => ({
    id: c.Id,
    name: (c.Name ?? "").replace(/^\//, ""),
    image: c.Image ?? "",
    imageName: c.Config?.Image ?? "",
    project: c.Config?.Labels?.["com.docker.compose.project"],
    running: Boolean(c.State?.Running),
    status: c.State?.Status ?? "",
    finishedAt: time(c.State?.FinishedAt),
    volumes: (c.Mounts ?? []).filter((m) => m.Type === "volume" && m.Name).map((m) => m.Name!),
    binds: (c.Mounts ?? []).filter((m) => m.Type === "bind" && m.Source).map((m) => m.Source!),
  }));
}

export function volumes(sh: Sh): VolumeInfo[] {
  const names = lines(sh(["docker", "volume", "ls", "-q"]).out);
  if (!names.length) return [];
  const df = json<{ Volumes?: Array<{ Name: string; Size?: string }> }>(sh(["docker", "system", "df", "-v", "--format", "json"]).out, {});
  const size = new Map((df.Volumes ?? []).map((v) => [v.Name, parseSize(v.Size ?? "")]));
  const raw = json<Array<{ Name: string; CreatedAt?: string; Labels?: Record<string, string> | null }>>(sh(["docker", "volume", "inspect", ...names]).out, []);
  return raw.map((v) => ({ name: v.Name, created: time(v.CreatedAt), project: v.Labels?.["com.docker.compose.project"], bytes: size.get(v.Name) ?? 0 }));
}

export function diskUse(sh: Sh, mount: string): { size: number; used: number; usedPct: number } {
  const nums = (lines(sh(["df", "-B1", "--output=size,used", mount]).out).pop() ?? "").split(/\s+/).map(Number);
  const [size = 0, used = 0] = nums;
  return { size, used, usedPct: size ? Math.round((used / size) * 1000) / 10 : 0 };
}

const duBytes = (sh: Sh, path: string) => Number(sh(["du", "-sb", path]).out.split(/\s/)[0]) || 0;

// ---- Tier A choices (pure) -----------------------------------------------------------------------

/** An image reference without its digest or tag: `reg:5000/a/b:1` → `reg:5000/a/b`. */
export const repoOf = (ref: string) => ref.replace(/@.*$/, "").replace(/:[^/:]+$/, "");

/** Tagged images no container uses (in any state), older than the minimum age, not protected and
 *  not pinned by the security kit. An image from the same repository as a protected (prod)
 *  container is prod-related too: it may be that container's rollback. Dangling images are left
 *  to `docker image prune`. */
export function pickImages(imgs: ImageInfo[], ctrs: ContainerInfo[], keep: Set<string>, cfg: DiskConfig, now: number): ImageInfo[] {
  const used = new Set(ctrs.map((c) => c.image));
  const prodRepos = new Set(ctrs.filter((c) => isProtected(cfg, c.name, c.imageName, c.project)).map((c) => repoOf(c.imageName)));
  const cutoff = now - cfg.minAgeDays * DAY;
  return imgs.filter(
    (i) =>
      i.tags.length > 0 &&
      !used.has(i.id) &&
      i.created > 0 &&
      i.created < cutoff &&
      !isProtected(cfg, ...i.tags) &&
      !i.tags.some((t) => prodRepos.has(repoOf(t))) &&
      !i.digests.some((d) => keep.has(d.slice(d.indexOf("@") + 1))),
  );
}

/** Containers that stopped (exited or dead) longer ago than the minimum age, and are not protected. */
export function pickContainers(ctrs: ContainerInfo[], cfg: DiskConfig, now: number): ContainerInfo[] {
  const cutoff = now - cfg.minAgeDays * DAY;
  return ctrs.filter(
    (c) => !c.running && (c.status === "exited" || c.status === "dead") && c.finishedAt > 0 && c.finishedAt < cutoff && !isProtected(cfg, c.name, c.imageName, c.project),
  );
}

/** A rotated or compressed log: `x.1`, `x.log.2.gz`, `x-20261011`, `.gz/.xz/.bz2/.zst`, `.old`. */
export function isRotatedLog(path: string): boolean {
  return /(\.\d+|[-.]\d{8})(\.(gz|xz|bz2|zst))?$|\.(gz|xz|bz2|zst|old)$/.test(basename(path));
}

/** Files under `root` that the /tmp rule removes: regular files or links whose atime, mtime and
 *  ctime are all older than the minimum age (the systemd-tmpfiles rule). Never inside a folder that
 *  holds `.git`, never a skipped system entry, a protected path, .env or a dump (Tier B). */
export function tmpVictims(root: string, cfg: DiskConfig, now: number): string[] {
  const cutoff = now - cfg.minAgeDays * DAY;
  const skip = cfg.tmpSkip.map((p) => new RegExp(p));
  const dump = new RegExp(cfg.dumpPattern, "i");
  const out: string[] = [];
  const walk = (dir: string, top: boolean) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (names.includes(".git")) return; // a repo or worktree: Tier B
    for (const name of names) {
      if (top && skip.some((r) => r.test(name))) continue;
      const p = join(dir, name);
      if (isProtected(cfg, p) || dump.test(name)) continue;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, false);
      else if ((st.isFile() || st.isSymbolicLink()) && Math.max(st.atimeMs, st.mtimeMs, st.ctimeMs) < cutoff) out.push(p);
    }
  };
  walk(root, true);
  return out;
}

function rotatedLogs(cfg: DiskConfig): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (cfg.logSkipDirs.includes(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && isRotatedLog(p) && !isProtected(cfg, p)) out.push(p);
    }
  };
  for (const r of cfg.logRoots) walk(r);
  return out;
}

// ---- Tier B candidates ---------------------------------------------------------------------------

export type CandidateKind = "volume" | "db-data" | "dump" | "worktree" | "build-output";
export interface Candidate {
  id: string;
  kind: CandidateKind;
  target: string;
  bytes: number;
  /** Last use: a file's or worktree's last change, a DB container's stop; an unused volume's creation. */
  lastUsed: number;
  project: string;
  /** worktree: the repository it belongs to. */
  repo?: string;
}

/** A stable id: the same item keeps its id across runs, so an approval means the same thing. */
export const candidateId = (kind: CandidateKind, target: string) => `b-${createHash("sha256").update(`${kind}\0${target}`).digest("hex").slice(0, 8)}`;

/** `/home/<p>/…` → p; anything else → "-". */
export const ownerOf = (path: string) => /^\/home\/([^/]+)/.exec(path)?.[1] ?? "-";

/** Volumes no container mounts (in any state), above the size floor, not protected. */
export function volumeCandidates(vols: VolumeInfo[], ctrs: ContainerInfo[], cfg: DiskConfig): Candidate[] {
  const mounted = new Set(ctrs.flatMap((c) => c.volumes));
  return vols
    .filter((v) => !mounted.has(v.name) && v.bytes >= cfg.volumeMinBytes && !isProtected(cfg, v.name, v.project))
    .map((v) => ({ id: candidateId("volume", v.name), kind: "volume" as const, target: v.name, bytes: v.bytes, lastUsed: v.created, project: v.project ?? "-" }));
}

function dbDataCandidates(sh: Sh, ctrs: ContainerInfo[], cfg: DiskConfig): Candidate[] {
  const db = new RegExp(cfg.dbImagePattern, "i");
  const live = new Set(ctrs.filter((c) => c.running).flatMap((c) => c.binds));
  return ctrs
    .filter((c) => !c.running && db.test(c.imageName) && !isProtected(cfg, c.name, c.imageName, c.project))
    .flatMap((c) => c.binds.filter((b) => !live.has(b) && !isProtected(cfg, b) && existsSync(b)).map((b) => ({ c, b })))
    .map(({ c, b }) => ({ id: candidateId("db-data", b), kind: "db-data" as const, target: b, bytes: duBytes(sh, b), lastUsed: c.finishedAt, project: c.project ?? ownerOf(b) }));
}

function dumpCandidates(sh: Sh, cfg: DiskConfig): Candidate[] {
  const out: Candidate[] = [];
  const pattern = new RegExp(cfg.dumpPattern, "i");
  const add = (p: string, bytes: number, mtime: number) => {
    if (bytes >= cfg.dumpMinBytes && !isProtected(cfg, p)) out.push({ id: candidateId("dump", p), kind: "dump", target: p, bytes, lastUsed: mtime, project: ownerOf(p) });
  };
  for (const root of cfg.dumpRoots.filter(existsSync)) {
    // Files named like dumps, and each entry of a backup(s) folder as one item.
    const found = sh([
      "find", root, "-xdev",
      "(", "-name", "node_modules", "-o", "-name", ".git", "-o", "-name", "proc", ")", "-prune",
      "-o", "(", "-type", "d", "(", "-iname", "backups", "-o", "-iname", "backup", ")", "-printf", "D\t%T@\t%p\n", "-prune", ")",
      "-o", "-type", "f", "-size", `+${Math.floor(cfg.dumpMinBytes / 1_000_000)}M`, "-printf", "F\t%T@\t%s\t%p\n",
    ]).out;
    for (const l of lines(found)) {
      const [t, mt, a, b] = l.split("\t");
      if (t === "F" && b && pattern.test(b)) add(b, Number(a), Number(mt) * 1000);
      if (t === "D" && a && !isProtected(cfg, a)) {
        for (const name of (() => { try { return readdirSync(a); } catch { return []; } })()) {
          const p = join(a, name);
          const st = (() => { try { return lstatSync(p); } catch { return undefined; } })();
          if (st) add(p, st.isDirectory() ? duBytes(sh, p) : st.size, st.mtimeMs);
        }
      }
    }
  }
  return out;
}

function worktreeCandidates(sh: Sh, cfg: DiskConfig): Candidate[] {
  const out: Candidate[] = [];
  let repos: string[] = [];
  try {
    repos = readdirSync(cfg.projectsRoot).map((n) => join(cfg.projectsRoot, n)).filter((p) => existsSync(join(p, ".git")) && lstatSync(join(p, ".git")).isDirectory());
  } catch {
    return out;
  }
  for (const repo of repos) {
    const r = sh(["git", "-C", repo, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    const paths = lines(r.out).filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
    for (const wt of paths.slice(1)) {
      if (!existsSync(wt) || isProtected(cfg, wt, repo)) continue;
      const last = Number(sh(["git", "-C", wt, "log", "-1", "--format=%ct"]).out.trim()) * 1000 || 0;
      out.push({ id: candidateId("worktree", wt), kind: "worktree", target: wt, bytes: duBytes(sh, wt), lastUsed: last, project: basename(repo), repo });
    }
  }
  return out;
}

function buildOutputCandidates(sh: Sh, cfg: DiskConfig): Candidate[] {
  if (!existsSync(cfg.projectsRoot)) return [];
  const names = cfg.buildOutputNames.flatMap((n, i) => (i ? ["-o", "-name", n] : ["-name", n]));
  const found = sh(["find", cfg.projectsRoot, "-mindepth", "2", "-maxdepth", "5", "-xdev", "-type", "d", "(", ...names, ")", "-prune", "-printf", "%T@\t%p\n"]).out;
  const out: Candidate[] = [];
  for (const l of lines(found)) {
    const [mt, p] = l.split("\t");
    if (!p || isProtected(cfg, p) || p.includes("/node_modules/")) continue;
    const bytes = duBytes(sh, p);
    if (bytes >= cfg.buildOutputMinBytes) out.push({ id: candidateId("build-output", p), kind: "build-output", target: p, bytes, lastUsed: Number(mt) * 1000, project: ownerOf(p) });
  }
  return out;
}

// ---- the goal --------------------------------------------------------------------------------------

/** The loop's goal (ADR-0040). Met — so a fire costs nothing — when use is under the target; when it
 *  is outside the daily hour and under the alert level; or when a clean within the cooldown freed
 *  less than the floor (nothing safe is left). `now` is read in server-local time. */
export function goalMet(input: { usedPct: number; lastRun?: { at: number; freedBytes: number } }, cfg: DiskConfig, now: number): { met: boolean; detail: string } {
  const { usedPct, lastRun } = input;
  if (usedPct < cfg.targetPct) return { met: true, detail: `disk ${usedPct}% < target ${cfg.targetPct}%` };
  const daily = new Date(now).getHours() === cfg.dailyHour;
  if (!daily && usedPct < cfg.alertPct) return { met: true, detail: `disk ${usedPct}% < alert ${cfg.alertPct}% (daily run at ${cfg.dailyHour}:00)` };
  if (lastRun && now - lastRun.at < cfg.cooldownHours * 3_600_000 && lastRun.freedBytes < cfg.nothingLeftBytes)
    return { met: true, detail: `disk ${usedPct}%, nothing safe left (last clean freed ${gb(lastRun.freedBytes)})` };
  return { met: false, detail: `disk ${usedPct}% ≥ ${daily ? cfg.targetPct : cfg.alertPct}%: cleanup due` };
}

// ---- running -------------------------------------------------------------------------------------

export const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
const day = (t: number) => (t ? new Date(t).toISOString().slice(0, 10) : "?");

function writeJson(file: string, data: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

export interface RunDeps {
  sh: Sh;
  cfg: DiskConfig;
  stateDir: string;
  now: number;
  keepDigests: Set<string>;
  dryRun?: boolean;
}

export interface RunResult {
  before: ReturnType<typeof diskUse>;
  after: ReturnType<typeof diskUse>;
  freed: Array<{ category: string; bytes: number; detail: string }>;
  freedTotal: number;
  candidates: Candidate[];
  report: string;
}

/** One cleanup: every Tier A step in order, each measured; then the Tier B list. */
export function runCleanup(d: RunDeps): RunResult {
  const { sh, cfg, now } = d;
  const before = diskUse(sh, cfg.mount);
  const imgs = images(sh);
  const ctrs = containers(sh);
  const vols = volumes(sh);
  const hours = cfg.minAgeDays * 24;
  const oldImages = pickImages(imgs, ctrs, d.keepDigests, cfg, now);
  const oldContainers = pickContainers(ctrs, cfg, now);
  const logs = rotatedLogs(cfg);
  const tmp = cfg.tmpRoots.flatMap((r) => tmpVictims(r, cfg, now));

  type Step = { category: string; commands: string[][]; files?: string[]; cwd?: string };
  const steps: Step[] = [
    { category: "dangling images", commands: [["docker", "image", "prune", "-f"]] },
    { category: "unused images", commands: oldImages.map((i) => ["docker", "rmi", ...i.tags]) },
    { category: "build cache", commands: [["docker", "builder", "prune", "-f", "--filter", `until=${hours}h`]] },
    { category: "stopped containers", commands: oldContainers.map((c) => ["docker", "rm", c.id]) },
    { category: "journal", commands: [["journalctl", `--vacuum-size=${cfg.journalMaxSize}`]] },
    { category: "rotated logs", commands: [], files: logs },
    { category: "/tmp", commands: [], files: tmp },
    ...cfg.packageCaches.map((p) => ({ category: `${p.name} cache`, commands: [p.argv], cwd: p.cwd })),
  ];

  const freed: RunResult["freed"] = [];
  let used = before.used;
  for (const s of steps) {
    const n = s.commands.length + (s.files?.length ?? 0);
    if (d.dryRun) {
      freed.push({ category: s.category, bytes: 0, detail: s.files ? `${s.files.length} files` : s.commands.map((c) => c.join(" ")).join("; ") || "nothing" });
      continue;
    }
    let failed = 0;
    let missing = 0;
    for (const c of s.commands) {
      const code = sh(c, s.cwd ? { cwd: s.cwd } : undefined).code;
      if (code === 127) missing++;
      else if (code !== 0) failed++;
    }
    for (const f of s.files ?? []) {
      try {
        rmSync(f, { force: true });
      } catch {
        failed++;
      }
    }
    const now2 = diskUse(sh, cfg.mount).used;
    const detail = missing && missing === n ? "not installed" : `${n - failed - missing}/${n}${failed + missing ? ` (${failed + missing} skipped)` : ""}`;
    freed.push({ category: s.category, bytes: Math.max(0, used - now2), detail });
    used = now2;
  }
  const after = d.dryRun ? before : diskUse(sh, cfg.mount);
  const freedTotal = freed.reduce((a, f) => a + f.bytes, 0);

  const candidates = [
    ...volumeCandidates(vols, ctrs, cfg),
    ...dbDataCandidates(sh, ctrs, cfg),
    ...dumpCandidates(sh, cfg),
    ...worktreeCandidates(sh, cfg),
    ...buildOutputCandidates(sh, cfg),
  ].sort((a, b) => b.bytes - a.bytes);

  const prevFile = join(d.stateDir, "candidates.json");
  const prev = existsSync(prevFile) ? json<{ at: number; items: Candidate[] }>(readFileSync(prevFile, "utf8"), { at: 0, items: [] }) : { at: 0, items: [] };
  const unchanged = prev.items.length === candidates.length && prev.items.every((p, i) => p.id === candidates[i]?.id);
  if (!d.dryRun) {
    writeJson(join(d.stateDir, "last-run.json"), { at: now, beforePct: before.usedPct, afterPct: after.usedPct, freedBytes: freedTotal, freed });
    writeJson(prevFile, { at: unchanged ? prev.at : now, items: candidates });
  }

  const tierB = candidates.reduce((a, c) => a + c.bytes, 0);
  const report = [
    d.dryRun ? `disk cleanup (dry run — nothing changed): ${before.usedPct}% used` : `disk ${before.usedPct}% → ${after.usedPct}% (freed ${gb(freedTotal)})`,
    "Tier A:",
    ...freed.map((f) => `  ${f.category.padEnd(20)} ${d.dryRun ? "" : gb(f.bytes).padStart(9)}  ${f.detail}`),
    unchanged && prev.at
      ? `Tier B: ${candidates.length} items, ${gb(tierB)} — unchanged since ${day(prev.at)} (list: ${prevFile})`
      : `Tier B (report only — never deleted without approval): ${candidates.length} items, ${gb(tierB)}`,
    ...(unchanged && prev.at
      ? []
      : candidates.slice(0, cfg.reportTop).map((c) => `  ${c.id}  ${c.kind.padEnd(12)} ${gb(c.bytes).padStart(9)}  dated ${day(c.lastUsed)}  ${c.project.padEnd(14)} ${c.target}`)),
    ...(!unchanged && candidates.length > cfg.reportTop ? [`  … ${candidates.length - cfg.reportTop} more${d.dryRun ? "" : ` in ${prevFile}`}`] : []),
  ].join("\n");
  return { before, after, freed, freedTotal, candidates, report };
}

/** Delete exactly the approved Tier B ids from the last list, each checked again first. Never forces. */
export function deleteApproved(ids: string[], d: { sh: Sh; cfg: DiskConfig; stateDir: string }): Array<{ id: string; target?: string; result: string }> {
  const list = json<{ items: Candidate[] }>(existsSync(join(d.stateDir, "candidates.json")) ? readFileSync(join(d.stateDir, "candidates.json"), "utf8") : "", { items: [] });
  const byId = new Map(list.items.map((c) => [c.id, c]));
  const ctrs = containers(d.sh);
  const mounted = new Set(ctrs.flatMap((c) => c.volumes));
  const liveBinds = new Set(ctrs.filter((c) => c.running).flatMap((c) => c.binds));
  return ids.map((id) => {
    const c = byId.get(id);
    if (!c) return { id, result: "unknown id (not in the last Tier B list): skipped" };
    if (isProtected(d.cfg, c.target, c.project === "-" ? undefined : c.project)) return { id, target: c.target, result: "protected: refused" };
    if (c.kind === "volume") {
      if (mounted.has(c.target)) return { id, target: c.target, result: "in use by a container now: skipped" };
      const r = d.sh(["docker", "volume", "rm", c.target]);
      return { id, target: c.target, result: r.code === 0 ? "deleted" : `docker refused: ${r.out.trim()}` };
    }
    if (c.kind === "worktree") {
      const r = d.sh(["git", "-C", c.repo ?? c.target, "worktree", "remove", c.target]);
      return { id, target: c.target, result: r.code === 0 ? "deleted" : `git refused: ${r.out.trim()}` };
    }
    if (liveBinds.has(c.target)) return { id, target: c.target, result: "mounted by a running container: skipped" };
    if (!existsSync(c.target)) return { id, target: c.target, result: "already gone" };
    rmSync(c.target, { recursive: true, force: true });
    return { id, target: c.target, result: "deleted" };
  });
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const kit = import.meta.dir;
  const cfg = loadDiskConfig(kit);
  const stateDir = join(kit, "state");
  const keepDigests = new Set(cfg.keepImagesFrom.filter(existsSync).flatMap((f) => [...parseKeepDigests(readFileSync(f, "utf8"))]));
  const lockFile = join(stateDir, "run.lock");
  const lastRun = () => json<{ at: number; freedBytes: number } | undefined>(existsSync(join(stateDir, "last-run.json")) ? readFileSync(join(stateDir, "last-run.json"), "utf8") : "", undefined);

  if (cmd === "check") {
    const g = goalMet({ usedPct: diskUse(realSh, cfg.mount).usedPct, lastRun: lastRun() }, cfg, Date.now());
    console.log(g.detail);
    process.exit(g.met ? 0 : 1);
  } else if (cmd === "measure") {
    const u = diskUse(realSh, cfg.mount);
    console.log(`disk ${u.usedPct}% used (${gb(u.used)} of ${gb(u.size)})`);
    console.log(realSh(["docker", "system", "df"]).out.trim());
  } else if (cmd === "run") {
    mkdirSync(stateDir, { recursive: true });
    const holder = existsSync(lockFile) ? Number(readFileSync(lockFile, "utf8")) : 0;
    if (holder && (() => { try { process.kill(holder, 0); return true; } catch { return false; } })()) {
      console.log(`another cleanup is running (pid ${holder}): skipped`);
      process.exit(0);
    }
    writeFileSync(lockFile, String(process.pid));
    try {
      console.log(runCleanup({ sh: realSh, cfg, stateDir, now: Date.now(), keepDigests, dryRun: rest.includes("--dry-run") }).report);
    } finally {
      rmSync(lockFile, { force: true });
    }
  } else if (cmd === "delete") {
    const at = rest.indexOf("--ids");
    const ids = (at >= 0 ? (rest[at + 1] ?? "") : "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) {
      console.error("usage: cleanup.ts delete --ids <id,id,...>  (ids from the last Tier B list)");
      process.exit(2);
    }
    for (const r of deleteApproved(ids, { sh: realSh, cfg, stateDir })) console.log(`${r.id}  ${r.target ?? ""}  ${r.result}`);
  } else {
    console.error("usage: bun cleanup.ts measure | check | run [--dry-run] | delete --ids <id,id,...>");
    process.exit(2);
  }
}
