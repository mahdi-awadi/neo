// Disk cleanup for this host (ADR-0040, ADR-0041). Deterministic: the decisions below are pure
// functions over an inventory, and every command goes through an injected shell, so tests never
// touch the host.
//
//   Tier A — rebuildable, removed automatically: dangling and unused images; build cache; stopped
//            containers; unused rebuildable volumes (anonymous, caches, node_modules, test); mounted
//            cache volumes over a cap (users stopped, emptied, started again); big container logs;
//            the journal; rotated logs; core dumps; old /tmp files and empty folders; build
//            outputs of projects with no live dev server; old test artifacts; clean finished
//            worktrees; package caches.
//   Tier B — irreversible, only LISTED: named volumes that may hold DB data, data folders of
//            stopped database containers, dumps and backups, worktrees with work in them. Each has
//            a stable id; `delete --ids` removes exactly the approved ones, checked again first.
//   Never:   a running container or its volumes, anything matching a protect pattern (prod, the
//            engine's data and company folders), .env files, the security kit's pinned images.
//
//   bun cleanup.ts measure | check | run [--dry-run] | delete --ids <id,id,...>
//
// Values live in defaults.json; a host overrides them in config.json next to the installed copy.
// State (last run, Tier B list) lives in ./state.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface DiskConfig {
  mount: string;
  alertPct: number;
  dailyHour: number;
  cooldownHours: number;
  nothingLeftBytes: number;
  minAgeDays: number;
  imageMinAgeDays: number;
  /** Build cache kept, least recently used goes first (`--max-used-space`, e.g. "10gb"). */
  buildCacheMaxUsedSpace: string;
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
  /** Removed when git ignores them and their project is not live. */
  buildOutputNames: string[];
  /** Removed when git ignores them and they are older than minAgeDays, in any project. */
  artifactNames: string[];
  buildOutputMaxDepth: number;
  volumeMinBytes: number;
  /** An unused volume whose name matches is rebuildable (Tier A); anonymous volumes are too. */
  rebuildableVolumePattern: string;
  /** A mounted volume whose name matches, above cacheVolumeMaxBytes, is wiped. */
  cacheVolumePattern: string;
  cacheVolumeMaxBytes: number;
  /** Containers never stopped for a wipe (an in-flight builder, a metrics store). */
  wipeSkipContainers: string[];
  /** Top-level entries a wipe keeps: `bin` holds tools installed into a GOPATH-style volume. */
  wipeKeep: string[];
  containerLogMaxBytes: number;
  coredumpDir: string;
  coredumpMaxAgeHours: number;
  dbImagePattern: string;
  reportTop: number;
}

/** Runs one command (no shell). A missing program is code 127, never a throw. `out` is stdout only,
 *  so a partial success (docker inspect with one id gone) still parses. */
export type Sh = (argv: string[], opts?: { cwd?: string }) => { code: number; out: string; err?: string };

export const realSh: Sh = (argv, opts) => {
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", cwd: opts?.cwd });
    return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
  } catch {
    return { code: 127, out: "", err: `${argv[0]}: not found` };
  }
};

/** A command's message for a report: stderr, else stdout. */
const message = (r: { out: string; err?: string }) => (r.err || r.out).trim();

/** The ids of a docker listing; a failed listing (docker down) stops the run, as below. */
function listed(what: string, r: { code: number; out: string; err?: string }): string[] {
  if (r.code !== 0) throw new Error(`docker ${what} inventory unreadable: ${message(r).slice(0, 200)}`);
  return lines(r.out);
}

/** Parse an inspect listing; ids were listed but nothing parsed means the inventory is unreadable,
 *  and the run must stop before it changes anything (an empty inventory reads as "nothing in use"). */
function inspected<T>(what: string, ids: string[], r: { out: string; err?: string }): T[] {
  const parsed = json<T[]>(r.out, []);
  if (ids.length && !parsed.length) throw new Error(`docker ${what} inventory unreadable: ${message(r).slice(0, 200)}`);
  return parsed;
}

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
  logPath?: string;
  logBytes?: number;
}
export interface VolumeInfo {
  name: string;
  created: number;
  project?: string;
  bytes: number;
  driver?: string;
  mountpoint?: string;
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
  const ids = [...new Set(listed("image", sh(["docker", "image", "ls", "-aq", "--no-trunc"])))];
  if (!ids.length) return [];
  const raw = inspected<{ Id: string; RepoTags?: string[]; RepoDigests?: string[]; Created?: string }>("image", ids, sh(["docker", "image", "inspect", ...ids]));
  return raw.map((i) => ({ id: i.Id, tags: (i.RepoTags ?? []).filter((t) => t !== "<none>:<none>"), digests: i.RepoDigests ?? [], created: time(i.Created) }));
}

export function containers(sh: Sh): ContainerInfo[] {
  const ids = listed("container", sh(["docker", "ps", "-aq", "--no-trunc"]));
  if (!ids.length) return [];
  type Raw = {
    Id: string;
    Name?: string;
    Image?: string;
    LogPath?: string;
    Config?: { Image?: string; Labels?: Record<string, string> | null };
    State?: { Status?: string; Running?: boolean; FinishedAt?: string };
    Mounts?: Array<{ Type?: string; Name?: string; Source?: string }>;
  };
  return inspected<Raw>("container", ids, sh(["docker", "container", "inspect", ...ids])).map((c) => ({
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
    logPath: c.LogPath || undefined,
  }));
}

export function volumes(sh: Sh): VolumeInfo[] {
  const names = listed("volume", sh(["docker", "volume", "ls", "-q"]));
  if (!names.length) return [];
  const df = json<{ Volumes?: Array<{ Name: string; Size?: string }> }>(sh(["docker", "system", "df", "-v", "--format", "json"]).out, {});
  const size = new Map((df.Volumes ?? []).map((v) => [v.Name, parseSize(v.Size ?? "")]));
  const raw = inspected<{ Name: string; Driver?: string; Mountpoint?: string; CreatedAt?: string; Labels?: Record<string, string> | null }>("volume", names, sh(["docker", "volume", "inspect", ...names]));
  return raw.map((v) => ({
    name: v.Name,
    created: time(v.CreatedAt),
    project: v.Labels?.["com.docker.compose.project"],
    bytes: size.get(v.Name) ?? 0,
    driver: v.Driver,
    mountpoint: v.Mountpoint,
  }));
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
  const cutoff = now - cfg.imageMinAgeDays * DAY;
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

/** What the /tmp rule removes under `root`: regular files or links whose atime, mtime and ctime are
 *  all older than the minimum age (the systemd-tmpfiles rule), then each folder that would be left
 *  empty, if it is that old too — listed after everything inside it. Never inside a folder that
 *  holds `.git`, never a skipped system entry, a protected path, .env or a dump (Tier B). */
export function tmpVictims(root: string, cfg: DiskConfig, now: number): string[] {
  const cutoff = now - cfg.minAgeDays * DAY;
  const skip = cfg.tmpSkip.map((p) => new RegExp(p));
  const dump = new RegExp(cfg.dumpPattern, "i");
  const out: string[] = [];
  /** Walks `dir`; true when everything in it goes. */
  const walk = (dir: string, top: boolean): boolean => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    if (names.includes(".git")) return false; // a repo or worktree: never here
    let all = true;
    for (const name of names) {
      const p = join(dir, name);
      if ((top && skip.some((r) => r.test(name))) || isProtected(cfg, p) || dump.test(name)) {
        all = false;
        continue;
      }
      let st;
      try {
        st = lstatSync(p);
      } catch {
        all = false;
        continue;
      }
      // reading a folder moves its atime, so a folder is judged by its mtime and ctime only
      if (st.isDirectory() && walk(p, false) && Math.max(st.mtimeMs, st.ctimeMs) < cutoff) out.push(p);
      else if (!st.isDirectory() && (st.isFile() || st.isSymbolicLink()) && Math.max(st.atimeMs, st.mtimeMs, st.ctimeMs) < cutoff) out.push(p);
      else all = false;
    }
    return all;
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

const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;
const isDbContainer = (cfg: DiskConfig, c: ContainerInfo) => new RegExp(cfg.dbImagePattern, "i").test(c.imageName);

/** Unused volumes that can be rebuilt: anonymous ones (a `docker run` leftover) and those whose name
 *  says cache, go mod/build, buildkit state, node_modules or test. Any size; never protected. */
export function pickUnusedVolumes(vols: VolumeInfo[], ctrs: ContainerInfo[], cfg: DiskConfig): VolumeInfo[] {
  const mounted = new Set(ctrs.flatMap((c) => c.volumes));
  const rebuildable = new RegExp(cfg.rebuildableVolumePattern, "i");
  return vols.filter((v) => !mounted.has(v.name) && (ANONYMOUS_VOLUME.test(v.name) || rebuildable.test(v.name)) && !isProtected(cfg, v.name, v.project));
}

/** Mounted cache volumes over the cap, on the local driver, that no DB, protected or skipped
 *  container mounts. `stop` is the running containers to stop around the wipe. */
export function pickCacheWipes(vols: VolumeInfo[], ctrs: ContainerInfo[], cfg: DiskConfig): Array<{ volume: VolumeInfo; stop: ContainerInfo[] }> {
  const cache = new RegExp(cfg.cacheVolumePattern, "i");
  const skip = cfg.wipeSkipContainers.map((p) => new RegExp(p));
  return vols.flatMap((v) => {
    const users = ctrs.filter((c) => c.volumes.includes(v.name));
    if (!users.length || !cache.test(v.name) || v.bytes <= cfg.cacheVolumeMaxBytes || v.driver !== "local" || !v.mountpoint) return [];
    if (isProtected(cfg, v.name, v.project)) return [];
    if (users.some((c) => isDbContainer(cfg, c) || isProtected(cfg, c.name, c.imageName, c.project) || skip.some((r) => r.test(c.name)))) return [];
    return [{ volume: v, stop: users.filter((c) => c.running) }];
  });
}

/** Containers whose json log is over the cap; never a protected one. */
export function pickLogTruncations(ctrs: ContainerInfo[], cfg: DiskConfig): ContainerInfo[] {
  return ctrs.filter((c) => !!c.logPath && (c.logBytes ?? 0) > cfg.containerLogMaxBytes && !isProtected(cfg, c.name, c.imageName, c.project));
}

/** Core dumps older than the cap. */
export function coredumpVictims(cfg: DiskConfig, now: number): string[] {
  const cutoff = now - cfg.coredumpMaxAgeHours * 3_600_000;
  let names: string[];
  try {
    names = readdirSync(cfg.coredumpDir);
  } catch {
    return [];
  }
  return names.map((n) => join(cfg.coredumpDir, n)).filter((p) => {
    try {
      const st = lstatSync(p);
      return st.isFile() && st.mtimeMs < cutoff;
    } catch {
      return false;
    }
  });
}

/** Projects (`/home/<p>`) with a live dev server: a running container binds a path inside one, or a
 *  host process works in one. A bind of `/home` or `/` itself (a monitor) names no project. */
export function liveProjects(ctrs: ContainerInfo[], cwds: string[]): Set<string> {
  const paths = [...ctrs.filter((c) => c.running).flatMap((c) => c.binds), ...cwds];
  return new Set(paths.map(ownerOf).filter((p) => p !== "-"));
}

/** The working folders of every host process. */
export function processCwds(): string[] {
  const out: string[] = [];
  for (const pid of (() => { try { return readdirSync("/proc"); } catch { return []; } })()) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      out.push(readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      // gone, or not ours to read
    }
  }
  return out;
}

export interface BuildDir {
  path: string;
  mtime: number;
  kind: "build" | "artifact";
}

function findBuildDirs(sh: Sh, cfg: DiskConfig): BuildDir[] {
  if (!existsSync(cfg.projectsRoot)) return [];
  const all = [...cfg.buildOutputNames, ...cfg.artifactNames];
  const names = all.flatMap((n, i) => (i ? ["-o", "-name", n] : ["-name", n]));
  const found = sh(["find", cfg.projectsRoot, "-mindepth", "2", "-maxdepth", String(cfg.buildOutputMaxDepth), "-xdev", "(", "-name", ".git", "-prune", ")", "-o", "-type", "d", "(", ...names, ")", "-prune", "-printf", "%T@\t%p\n"]).out;
  return lines(found).flatMap((l) => {
    const [mt, p] = l.split("\t");
    if (!p) return [];
    return [{ path: p, mtime: Number(mt) * 1000, kind: cfg.artifactNames.includes(basename(p)) ? ("artifact" as const) : ("build" as const) }];
  });
}

/** Build outputs and test artifacts that go: git ignores the folder and tracks nothing in it (the
 *  `git clean -X` rule; outside a repo nothing goes). A build output only in a project that is not
 *  live; an artifact in any project, once older than the minimum age. */
export function pickBuildOutputs(found: BuildDir[], live: Set<string>, sh: Sh, cfg: DiskConfig, now: number): string[] {
  const cutoff = now - cfg.minAgeDays * DAY;
  return found
    .filter((b) => !isProtected(cfg, b.path) && (b.kind === "build" ? !live.has(ownerOf(b.path)) : b.mtime < cutoff))
    .filter((b) => {
      const dir = dirname(b.path);
      const name = basename(b.path);
      if (sh(["git", "-C", dir, "check-ignore", "-q", name]).code !== 0) return false;
      const tracked = sh(["git", "-C", dir, "ls-files", "--", name]);
      return tracked.code === 0 && tracked.out.trim() === "";
    })
    .map((b) => b.path);
}

export interface WorktreeInfo {
  path: string;
  repo: string;
  /** No change, staged or untracked (ignored files do not count). */
  clean: boolean;
  /** Its HEAD is reachable from a ref other than its own branch: merged or pushed. */
  onOtherRef: boolean;
  lastCommit: number;
  bytes?: number;
}

function worktrees(sh: Sh, cfg: DiskConfig): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let repos: string[] = [];
  try {
    repos = readdirSync(cfg.projectsRoot).map((n) => join(cfg.projectsRoot, n)).filter((p) => existsSync(join(p, ".git")) && lstatSync(join(p, ".git")).isDirectory());
  } catch {
    return out;
  }
  for (const repo of repos) {
    const r = sh(["git", "-C", repo, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    const blocks = r.out.split(/\n\s*\n/).map((b) => lines(b)).filter((b) => b.length);
    for (const b of blocks.slice(1)) {
      const field = (k: string) => b.find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
      const wt = field("worktree");
      if (!wt || !existsSync(wt) || isProtected(cfg, wt, repo)) continue;
      const head = field("HEAD") ?? "";
      const own = field("branch");
      const status = sh(["git", "-C", wt, "status", "--porcelain"]);
      const refs = lines(sh(["git", "-C", repo, "for-each-ref", "--contains", head, "--format=%(refname)"]).out).filter((ref) => ref !== own);
      out.push({
        path: wt,
        repo,
        clean: status.code === 0 && status.out.trim() === "",
        onOtherRef: !!head && refs.length > 0,
        lastCommit: Number(sh(["git", "-C", wt, "log", "-1", "--format=%ct"]).out.trim()) * 1000 || 0,
        bytes: duBytes(sh, wt),
      });
    }
  }
  return out;
}

/** Worktrees that go: clean, HEAD on another ref, last commit older than the minimum age, no
 *  process working inside. `git worktree remove` (no force) checks again. */
export function pickWorktrees(wts: WorktreeInfo[], cwds: string[], cfg: DiskConfig, now: number): WorktreeInfo[] {
  const cutoff = now - cfg.minAgeDays * DAY;
  return wts.filter(
    (w) => w.clean && w.onOtherRef && w.lastCommit > 0 && w.lastCommit < cutoff && !cwds.some((c) => c === w.path || c.startsWith(`${w.path}/`)) && !isProtected(cfg, w.path, w.repo),
  );
}

// ---- Tier B candidates ---------------------------------------------------------------------------

export type CandidateKind = "volume" | "db-data" | "dump" | "worktree";
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

/** Volumes no container mounts (in any state) that may hold real DB data: named, not rebuildable,
 *  above the size floor, not protected. */
export function volumeCandidates(vols: VolumeInfo[], ctrs: ContainerInfo[], cfg: DiskConfig): Candidate[] {
  const mounted = new Set(ctrs.flatMap((c) => c.volumes));
  const auto = new Set(pickUnusedVolumes(vols, ctrs, cfg).map((v) => v.name));
  return vols
    .filter((v) => !mounted.has(v.name) && !auto.has(v.name) && v.bytes >= cfg.volumeMinBytes && !isProtected(cfg, v.name, v.project))
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

/** Worktrees the automatic rule left: dirty, unpushed, recent or in use. */
function worktreeCandidates(wts: WorktreeInfo[]): Candidate[] {
  return wts.map((w) => ({ id: candidateId("worktree", w.path), kind: "worktree" as const, target: w.path, bytes: w.bytes ?? 0, lastUsed: w.lastCommit, project: basename(w.repo), repo: w.repo }));
}

// ---- the goal --------------------------------------------------------------------------------------

/** The loop's goal (ADR-0041). Not met — so the loop cleans — once a day in the daily hour, whatever
 *  the use; and outside it when use is at or above the alert level, unless a clean within the
 *  cooldown freed less than the floor (nothing safe is left). `now` is read in server-local time. */
export function goalMet(input: { usedPct: number; lastRun?: { at: number; freedBytes: number } }, cfg: DiskConfig, now: number): { met: boolean; detail: string } {
  const { usedPct, lastRun } = input;
  const hourStart = new Date(now);
  hourStart.setMinutes(0, 0, 0);
  if (hourStart.getHours() === cfg.dailyHour && !(lastRun && lastRun.at >= hourStart.getTime())) return { met: false, detail: `disk ${usedPct}%: daily cleanup due (${cfg.dailyHour}:00)` };
  if (usedPct < cfg.alertPct) return { met: true, detail: `disk ${usedPct}% < alert ${cfg.alertPct}% (daily run at ${cfg.dailyHour}:00)` };
  if (lastRun && now - lastRun.at < cfg.cooldownHours * 3_600_000 && lastRun.freedBytes < cfg.nothingLeftBytes)
    return { met: true, detail: `disk ${usedPct}%, nothing safe left (last clean freed ${gb(lastRun.freedBytes)})` };
  return { met: false, detail: `disk ${usedPct}% ≥ ${cfg.alertPct}%: cleanup due` };
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
  /** Working folders of host processes (live projects, busy worktrees); default: read /proc. */
  cwds?: string[];
  /** Size of a container's log file; default: stat it. */
  logBytes?: (path: string) => number;
}

export interface RunResult {
  before: ReturnType<typeof diskUse>;
  after: ReturnType<typeof diskUse>;
  freed: Array<{ category: string; bytes: number; detail: string }>;
  freedTotal: number;
  candidates: Candidate[];
  report: string;
}

const fileBytes = (p: string) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};

/** Empty a folder, keeping the folder itself and the `keep` entries at its top. */
function emptyDir(dir: string, keep: string[]): void {
  for (const name of readdirSync(dir)) if (!keep.includes(name)) rmSync(join(dir, name), { recursive: true, force: true });
}

/** A step's own action, for work that is more than a list of commands. */
type Action = { label: string; run: () => { ok: boolean; note?: string } };

/** Stop the running users, empty the volume, start them again — the start runs even if the empty fails. */
function wipeAction(sh: Sh, w: { volume: VolumeInfo; stop: ContainerInfo[] }, keep: string[]): Action {
  const ids = w.stop.map((c) => c.id);
  return {
    label: `wipe ${w.volume.name} (${gb(w.volume.bytes)})${ids.length ? `, restart ${w.stop.map((c) => c.name).join(",")}` : ""}`,
    run: () => {
      if (ids.length && sh(["docker", "stop", ...ids]).code !== 0) return { ok: false, note: `could not stop ${w.stop.map((c) => c.name).join(",")}` };
      let ok = true;
      try {
        emptyDir(w.volume.mountpoint!, keep);
      } catch {
        ok = false;
      } finally {
        if (ids.length) {
          const failed = w.stop.filter((c) => sh(["docker", "start", c.id]).code !== 0).map((c) => c.name);
          if (failed.length) return { ok: false, note: `NOT restarted: ${failed.join(",")}` };
        }
      }
      return { ok };
    },
  };
}

/** One cleanup: every Tier A step in order, each measured; then the Tier B list. */
export function runCleanup(d: RunDeps): RunResult {
  const { sh, cfg, now } = d;
  const before = diskUse(sh, cfg.mount);
  const cwds = d.cwds ?? processCwds();
  const sizeOf = d.logBytes ?? fileBytes;
  const imgs = images(sh);
  const ctrs = containers(sh).map((c) => ({ ...c, logBytes: c.logPath ? sizeOf(c.logPath) : 0 }));
  const vols = volumes(sh);
  const wts = worktrees(sh, cfg);
  const oldImages = pickImages(imgs, ctrs, d.keepDigests, cfg, now);
  const oldContainers = pickContainers(ctrs, cfg, now);
  const unusedVolumes = pickUnusedVolumes(vols, ctrs, cfg);
  const wipes = pickCacheWipes(vols, ctrs, cfg);
  const bigLogs = pickLogTruncations(ctrs, cfg);
  const logs = rotatedLogs(cfg);
  const cores = coredumpVictims(cfg, now);
  const tmp = cfg.tmpRoots.flatMap((r) => tmpVictims(r, cfg, now));
  const builds = pickBuildOutputs(findBuildDirs(sh, cfg), liveProjects(ctrs, cwds), sh, cfg, now);
  const doneWorktrees = pickWorktrees(wts, cwds, cfg, now);

  type Step = { category: string; commands?: string[][]; files?: string[]; dirs?: string[]; actions?: Action[]; cwd?: string };
  const steps: Step[] = [
    { category: "dangling images", commands: [["docker", "image", "prune", "-f"]] },
    { category: "unused images", commands: oldImages.map((i) => ["docker", "rmi", ...i.tags]) },
    { category: "build cache", commands: [["docker", "builder", "prune", "-af", "--max-used-space", cfg.buildCacheMaxUsedSpace]] },
    { category: "stopped containers", commands: oldContainers.map((c) => ["docker", "rm", c.id]) },
    { category: "unused volumes", commands: unusedVolumes.map((v) => ["docker", "volume", "rm", v.name]) },
    { category: "cache volumes", actions: wipes.map((w) => wipeAction(sh, w, cfg.wipeKeep)) },
    { category: "container logs", commands: bigLogs.map((c) => ["truncate", "-s", "0", c.logPath!]) },
    { category: "journal", commands: [["journalctl", `--vacuum-size=${cfg.journalMaxSize}`]] },
    { category: "rotated logs", files: logs },
    { category: "core dumps", files: cores },
    { category: "/tmp", files: tmp },
    { category: "build outputs", dirs: builds },
    { category: "worktrees", commands: doneWorktrees.map((w) => ["git", "-C", w.repo, "worktree", "remove", w.path]) },
    ...cfg.packageCaches.map((p) => ({ category: `${p.name} cache`, commands: [p.argv], cwd: p.cwd })),
  ];

  const freed: RunResult["freed"] = [];
  let used = before.used;
  for (const s of steps) {
    const commands = s.commands ?? [];
    const n = commands.length + (s.files?.length ?? 0) + (s.dirs?.length ?? 0) + (s.actions?.length ?? 0);
    if (d.dryRun) {
      const what = [...commands.map((c) => c.join(" ")), ...(s.actions ?? []).map((a) => a.label)].join("; ");
      freed.push({ category: s.category, bytes: 0, detail: s.files ? `${s.files.length} files` : s.dirs ? `${s.dirs.length} folders` : what || "nothing" });
      continue;
    }
    let failed = 0;
    let missing = 0;
    const notes: string[] = [];
    for (const c of commands) {
      const code = sh(c, s.cwd ? { cwd: s.cwd } : undefined).code;
      if (code === 127) missing++;
      else if (code !== 0) failed++;
    }
    for (const f of s.files ?? []) {
      try {
        rmSync(f, { force: true });
      } catch {
        try {
          rmdirSync(f); // an emptied /tmp folder; refuses one that is not empty
        } catch {
          failed++;
        }
      }
    }
    for (const dir of s.dirs ?? []) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        failed++;
      }
    }
    for (const a of s.actions ?? []) {
      const r = a.run();
      if (!r.ok) failed++;
      if (r.note) notes.push(r.note);
    }
    const now2 = diskUse(sh, cfg.mount).used;
    const detail = missing && missing === n ? "not installed" : `${n - failed - missing}/${n}${failed + missing ? ` (${failed + missing} skipped)` : ""}${notes.length ? ` — ${notes.join("; ")}` : ""}`;
    freed.push({ category: s.category, bytes: Math.max(0, used - now2), detail });
    used = now2;
  }
  const after = d.dryRun ? before : diskUse(sh, cfg.mount);
  const freedTotal = freed.reduce((a, f) => a + f.bytes, 0);

  const removedWorktrees = new Set(d.dryRun ? [] : doneWorktrees.map((w) => w.path));
  const candidates = [
    ...volumeCandidates(vols, ctrs, cfg),
    ...dbDataCandidates(sh, ctrs, cfg),
    ...dumpCandidates(sh, cfg),
    ...worktreeCandidates(wts.filter((w) => !removedWorktrees.has(w.path) && !(d.dryRun && doneWorktrees.includes(w)))),
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
      return { id, target: c.target, result: r.code === 0 ? "deleted" : `docker refused: ${message(r)}` };
    }
    if (c.kind === "worktree") {
      const r = d.sh(["git", "-C", c.repo ?? c.target, "worktree", "remove", c.target]);
      return { id, target: c.target, result: r.code === 0 ? "deleted" : `git refused: ${message(r)}` };
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
