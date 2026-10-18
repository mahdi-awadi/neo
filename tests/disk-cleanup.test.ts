import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateId,
  coredumpVictims,
  deleteApproved,
  goalMet,
  isProtected,
  isRotatedLog,
  loadDiskConfig,
  parseKeepDigests,
  liveProjects,
  pickBuildOutputs,
  pickCacheWipes,
  pickContainers,
  pickImages,
  pickLogTruncations,
  pickUnusedVolumes,
  pickWorktrees,
  runCleanup,
  tmpVictims,
  volumeCandidates,
  type Candidate,
  type ContainerInfo,
  type ImageInfo,
  type Sh,
  type VolumeInfo,
  type WorktreeInfo,
} from "../tools/disk/cleanup";
import { installDiskKit } from "../tools/disk/install";

const KIT = join(import.meta.dir, "..", "tools", "disk");
const cfg = loadDiskConfig(KIT, "/nonexistent-home");
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-17T10:00:00Z");

const img = (o: Partial<ImageInfo>): ImageInfo => ({ id: "sha256:x", tags: ["app:1"], digests: [], created: NOW - 30 * DAY, ...o });
const ctr = (o: Partial<ContainerInfo>): ContainerInfo => ({
  id: "c1",
  name: "web",
  image: "sha256:x",
  imageName: "app:1",
  running: false,
  status: "exited",
  finishedAt: NOW - 30 * DAY,
  volumes: [],
  binds: [],
  ...o,
});

describe("disk cleanup: what is protected", () => {
  test("prod names, the engine's data and company folders, and .env files", () => {
    expect(isProtected(cfg, "eticket-prod_api")).toBe(true);
    expect(isProtected(cfg, "prod-postgres")).toBe(true);
    expect(isProtected(cfg, "/home/neo/data/ledger.db.bak-v4")).toBe(true);
    expect(isProtected(cfg, "/home/neo/company/x")).toBe(true);
    expect(isProtected(cfg, "/tmp/a/.env.local")).toBe(true);
    expect(isProtected(cfg, "/home/neo/database")).toBe(false); // not /home/neo/data/
    expect(isProtected(cfg, "wasilni-web:e2e-a")).toBe(false);
  });

  test("the security kit's pinned scanner digests are read from images.env", () => {
    const keep = parseKeepDigests("# c\nSEMGREP_IMAGE=semgrep/semgrep@sha256:aa11\nX=bad\nGITLEAKS_IMAGE=z/g@sha256:bb22\n");
    expect([...keep].sort()).toEqual(["sha256:aa11", "sha256:bb22"]);
  });
});

describe("disk cleanup: Tier A choices", () => {
  test("images: only tagged, unused, old, unprotected and unpinned ones", () => {
    const images = [
      img({ id: "old-unused", tags: ["app:old"] }),
      img({ id: "used-by-stopped", tags: ["app:2"] }),
      img({ id: "young", tags: ["app:3"], created: NOW - 1 * DAY }),
      img({ id: "three-days", tags: ["app:4"], created: NOW - 3 * DAY }),
      img({ id: "prod", tags: ["eticket-prod-api:latest"] }),
      img({ id: "pinned", tags: ["semgrep/semgrep:1"], digests: ["semgrep/semgrep@sha256:aa11"] }),
      img({ id: "dangling", tags: [] }), // `docker image prune` handles these
    ];
    const containers = [ctr({ image: "used-by-stopped", running: false })];
    expect(pickImages(images, containers, new Set(["sha256:aa11"]), cfg, NOW).map((i) => i.id)).toEqual(["old-unused", "three-days"]);
  });

  test("images: the repository of a prod container is prod-related, so its older images stay (rollback)", () => {
    const images = [
      img({ id: "pg-old", tags: ["postgres@sha256:7456"] }),
      img({ id: "pg-14", tags: ["postgres:14"] }),
      img({ id: "reg-old", tags: ["reg.local:5000/team/api:1"] }),
      img({ id: "other", tags: ["redis:7"] }),
    ];
    const containers = [
      ctr({ name: "prod-postgres", imageName: "postgres:15-alpine", image: "pg-15", running: true }),
      ctr({ name: "x", project: "eticket-prod", imageName: "reg.local:5000/team/api:2", image: "reg-new", running: true }),
    ];
    expect(pickImages(images, containers, new Set(), cfg, NOW).map((i) => i.id)).toEqual(["other"]);
  });

  test("the engine's own node_modules is protected", () => {
    expect(isProtected(cfg, "/home/neo/node_modules")).toBe(true);
    expect(isProtected(cfg, "/home/waselni/node_modules")).toBe(false);
  });

  test("containers: stopped more than 7 days ago, never running, never protected", () => {
    const cs = [
      ctr({ id: "old" }),
      ctr({ id: "running", running: true, status: "running" }),
      ctr({ id: "recent", finishedAt: NOW - 3 * DAY }),
      ctr({ id: "never-ran", status: "created", finishedAt: 0 }),
      ctr({ id: "prod-name", name: "prod-ops-worker" }),
      ctr({ id: "prod-project", project: "eticket-prod" }),
      ctr({ id: "prod-image", imageName: "prod-postgres:16" }),
      ctr({ id: "dead", status: "dead" }),
    ];
    expect(pickContainers(cs, cfg, NOW).map((c) => c.id)).toEqual(["old", "dead"]);
  });

  test("rotated or compressed logs, never the live file", () => {
    for (const p of ["/var/log/messages-20261011.gz", "/var/log/cron-20260920", "/var/log/dnf.log.1", "/var/log/x.log.2.gz", "/var/log/a.old", "/var/log/b.xz"])
      expect([p, isRotatedLog(p)]).toEqual([p, true]);
    for (const p of ["/var/log/messages", "/var/log/dnf.log", "/var/log/neo.log", "/var/log/btmp"]) expect([p, isRotatedLog(p)]).toEqual([p, false]);
  });

  test("/tmp: regular files older than the cutoff on all three clocks; never a repo, .env, dump or system dir", () => {
    const root = mkdtempSync(join(tmpdir(), "disk-tmp-"));
    const now = Date.now() + 30 * DAY; // every real ctime is older than the cutoff
    const old = new Date(Date.now() - 400 * DAY);
    const put = (rel: string, fresh = false) => {
      const f = join(root, rel);
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "x");
      const t = fresh ? new Date(now) : old;
      utimesSync(f, t, t);
      return f;
    };
    const victim = put("old.txt");
    const nested = put("dir/deep/old.log");
    put("fresh.txt", true);
    put("repo/.git/HEAD");
    put("repo/src/old.ts");
    put("proj/.env");
    put("dump.sql.gz");
    put("systemd-private-abc/tmp/x");
    put("tmux-0/default");
    put("prod-export/data.csv");
    mkdirSync(join(root, "empty/inner"), { recursive: true });
    const got = tmpVictims(root, cfg, now);
    // folders that end up empty go too, each after everything inside it
    expect(got.sort()).toEqual([nested, victim, join(root, "dir/deep"), join(root, "dir"), join(root, "empty/inner"), join(root, "empty")].sort());
    const order = tmpVictims(root, cfg, now);
    expect(order.indexOf(join(root, "dir/deep"))).toBeLessThan(order.indexOf(join(root, "dir")));
    expect(order.indexOf(nested)).toBeLessThan(order.indexOf(join(root, "dir/deep")));
  });
});

const vol = (o: Partial<VolumeInfo>): VolumeInfo => ({ name: "v", created: NOW - 60 * DAY, bytes: 3e9, driver: "local", mountpoint: "/nonexistent", ...o });
const ANON = "e6f4d782222116639b7b0dd3cee89cc8099c15a7757a62e08af7553e3abd1dbd";

describe("disk cleanup: Tier A volumes", () => {
  test("unused volumes go when anonymous or named rebuildable (cache, go mod/build, buildkit, node_modules, test)", () => {
    const vols = [
      vol({ name: "etkt_gocache" }),
      vol({ name: "trivy-cache-contantme" }),
      vol({ name: "adminli-dev_adminli_go_mod" }),
      vol({ name: "p7_gobuild" }),
      vol({ name: "buildx_buildkit_builder-b4dd0_state" }),
      vol({ name: "gold_e2e_node_modules" }),
      vol({ name: "pgbrtest499845-data" }),
      vol({ name: ANON, bytes: 1000 }), // no size floor in Tier A
      vol({ name: "ws_postgres_data" }), // may be real DB data: Tier B
      vol({ name: "eticket-prod_cache" }), // protected
      vol({ name: "mounted_go_build_cache" }),
    ];
    const cs = [ctr({ running: false, volumes: ["mounted_go_build_cache"] })];
    expect(pickUnusedVolumes(vols, cs, cfg).map((v) => v.name)).toEqual([
      "etkt_gocache", "trivy-cache-contantme", "adminli-dev_adminli_go_mod", "p7_gobuild", "buildx_buildkit_builder-b4dd0_state", "gold_e2e_node_modules", "pgbrtest499845-data", ANON,
    ]);
  });

  test("a mounted cache volume over the cap is wiped; its running users are stopped and started, never a DB, protected or skipped one", () => {
    const big = cfg.cacheVolumeMaxBytes + 1;
    const vols = [
      vol({ name: "eticket-dev_travel_service_go_build_cache", bytes: big }),
      vol({ name: "small_go_cache", bytes: cfg.cacheVolumeMaxBytes - 1 }),
      vol({ name: "eticket-v3_postgres_data", bytes: big }), // not a cache
      vol({ name: "db_shared_cache", bytes: big }), // a DB container mounts it
      vol({ name: "builder_state_cache", bytes: big }), // an in-flight builder mounts it
      vol({ name: "nfs_go_cache", bytes: big, driver: "nfs" }), // not local: no mountpoint to empty
      vol({ name: "stopped_go_cache", bytes: big }),
      vol({ name: "vps_netdata-cache", bytes: big }),
    ];
    const cs = [
      ctr({ id: "t1", name: "eticket-travel-service", running: true, status: "running", volumes: ["eticket-dev_travel_service_go_build_cache"] }),
      ctr({ id: "t2", name: "old-runner", running: false, volumes: ["eticket-dev_travel_service_go_build_cache"] }),
      ctr({ id: "s", name: "x", running: true, volumes: ["small_go_cache"] }),
      ctr({ id: "pg", name: "pg", imageName: "postgres:16", running: true, volumes: ["eticket-v3_postgres_data", "db_shared_cache"] }),
      ctr({ id: "bk", name: "buildx_buildkit_builder-d7a20", running: true, volumes: ["builder_state_cache"] }),
      ctr({ id: "n", name: "y", running: true, volumes: ["nfs_go_cache"] }),
      ctr({ id: "st", name: "z", running: false, volumes: ["stopped_go_cache"] }),
      ctr({ id: "nd", name: "netdata", running: true, volumes: ["vps_netdata-cache"] }),
    ];
    const got = pickCacheWipes(vols, cs, cfg);
    expect(got.map((w) => w.volume.name)).toEqual(["eticket-dev_travel_service_go_build_cache", "stopped_go_cache"]);
    expect(got[0]!.stop.map((c) => c.id)).toEqual(["t1"]);
    expect(got[1]!.stop).toEqual([]);
  });

  test("container logs over the cap are truncated, never a protected container's", () => {
    const cs = [
      ctr({ id: "big", name: "eticket-mongodb", logPath: "/l/big", logBytes: cfg.containerLogMaxBytes + 1 }),
      ctr({ id: "small", logPath: "/l/small", logBytes: 10 }),
      ctr({ id: "prod", name: "prod-postgres", logPath: "/l/prod", logBytes: cfg.containerLogMaxBytes * 9 }),
      ctr({ id: "nopath", logBytes: cfg.containerLogMaxBytes * 9 }),
    ];
    expect(pickLogTruncations(cs, cfg).map((c) => c.id)).toEqual(["big"]);
  });
});

describe("disk cleanup: Tier A files", () => {
  test("core dumps older than the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "disk-core-"));
    const now = Date.now();
    const put = (name: string, ageH: number) => {
      const f = join(dir, name);
      writeFileSync(f, "x");
      const t = new Date(now - ageH * 3_600_000);
      utimesSync(f, t, t);
      return f;
    };
    const old = put("core.node.1.zst", cfg.coredumpMaxAgeHours + 2);
    put("core.node.2.zst", 1);
    expect(coredumpVictims({ ...cfg, coredumpDir: dir }, now)).toEqual([old]);
    expect(coredumpVictims({ ...cfg, coredumpDir: "/nonexistent" }, now)).toEqual([]);
  });

  test("a live project: a running container binds a path inside it, or a host process works in it", () => {
    const cs = [
      ctr({ running: true, binds: ["/home/eticket-v3/services/travel", "/var/run/docker.sock", "/home", "/"] }),
      ctr({ running: false, binds: ["/home/nutrizoid/web"] }),
    ];
    expect([...liveProjects(cs, ["/home/gold/ui", "/root", "/home/neo"])].sort()).toEqual(["eticket-v3", "gold", "neo"]);
  });

  test("build outputs: only git-ignored folders that track nothing; build kinds only outside live projects, artifacts only when old", () => {
    const found = [
      { path: "/home/nutrizoid/node_modules", mtime: NOW, kind: "build" as const },
      { path: "/home/safari/backend-ota/src/Api/bin", mtime: NOW, kind: "build" as const },
      { path: "/home/tools/bin", mtime: NOW, kind: "build" as const }, // tracked scripts
      { path: "/home/plain/dist", mtime: NOW, kind: "build" as const }, // not a git repo
      { path: "/home/eticket-v3/ui/node_modules", mtime: NOW, kind: "build" as const }, // live
      { path: "/home/eticket-v3/ui/coverage", mtime: NOW - 30 * DAY, kind: "artifact" as const }, // old artifact: any project
      { path: "/home/eticket-v3/ui/test-results", mtime: NOW - 1 * DAY, kind: "artifact" as const }, // young
      { path: "/home/neo/node_modules", mtime: NOW, kind: "build" as const }, // protected
    ];
    const sh: Sh = (argv) => {
      const [, , dir, verb, ...rest] = argv; // git -C <dir> <verb> …
      const path = `${dir}/${rest[rest.length - 1]}`;
      if (dir!.startsWith("/home/plain")) return { code: 128, out: "fatal: not a git repository" };
      if (verb === "check-ignore") return { code: path === "/home/tools/bin" ? 1 : 0, out: "" };
      if (verb === "ls-files") return { code: 0, out: path === "/home/tools/bin" ? "bin/run.sh\n" : "" };
      return { code: 1, out: "" };
    };
    expect(pickBuildOutputs(found, new Set(["eticket-v3"]), sh, cfg, NOW)).toEqual([
      "/home/nutrizoid/node_modules", "/home/safari/backend-ota/src/Api/bin", "/home/eticket-v3/ui/coverage",
    ]);
  });

  test("worktrees: clean, HEAD on another ref, idle, nobody inside — the rest stay for the operator", () => {
    const wt = (o: Partial<WorktreeInfo>): WorktreeInfo => ({ path: "/home/a/.worktrees/x", repo: "/home/a", clean: true, onOtherRef: true, lastCommit: NOW - 30 * DAY, ...o });
    const wts = [
      wt({ path: "/home/a/.worktrees/merged" }),
      wt({ path: "/home/a/.worktrees/dirty", clean: false }),
      wt({ path: "/home/a/.worktrees/unpushed", onOtherRef: false }),
      wt({ path: "/home/a/.worktrees/fresh", lastCommit: NOW - DAY }),
      wt({ path: "/home/a/.worktrees/busy" }),
      wt({ path: "/home/prod-ops/.worktrees/x" }),
    ];
    expect(pickWorktrees(wts, ["/home/a/.worktrees/busy/src"], cfg, NOW).map((w) => w.path)).toEqual(["/home/a/.worktrees/merged"]);
  });
});

describe("disk cleanup: Tier B candidates", () => {
  test("only unused named volumes that may hold real DB data, above the size floor, with a stable id", () => {
    const vols = [
      vol({ name: "trivy-cache" }), // rebuildable: Tier A
      vol({ name: ANON }), // anonymous: Tier A
      vol({ name: "in-use" }),
      vol({ name: "used-by-stopped" }),
      vol({ name: "eticket-prod_pg" }),
      vol({ name: "tiny", bytes: 1000 }),
      vol({ name: "ws_db", project: "ws" }),
    ];
    const cs = [ctr({ running: true, volumes: ["in-use"] }), ctr({ volumes: ["used-by-stopped"] })];
    const got = volumeCandidates(vols, cs, cfg);
    expect(got.map((c) => c.target)).toEqual(["ws_db"]);
    expect(got[0]).toMatchObject({ kind: "volume", bytes: 3e9, project: "ws", id: candidateId("volume", "ws_db") });
    expect(candidateId("volume", "ws_db")).toBe(candidateId("volume", "ws_db"));
    expect(candidateId("volume", "ws_db")).not.toBe(candidateId("dump", "ws_db"));
  });
});

describe("disk cleanup: the goal", () => {
  const at = (hour: number, dayOfMonth = 17) => Date.parse(`2026-10-${dayOfMonth}T${String(hour).padStart(2, "0")}:30:00`); // server-local

  test("the daily hour: one run a day whatever the use", () => {
    expect(goalMet({ usedPct: 20 }, cfg, at(4)).met).toBe(false);
    expect(goalMet({ usedPct: 20, lastRun: { at: at(4, 16), freedBytes: 9e9 } }, cfg, at(4)).met).toBe(false); // yesterday's
    expect(goalMet({ usedPct: 20, lastRun: { at: at(4) - 60_000, freedBytes: 9e9 } }, cfg, at(4)).met).toBe(true); // done today
  });
  test("outside the daily hour: met under the alert level, not at or over it", () => {
    expect(goalMet({ usedPct: 79 }, cfg, at(13)).met).toBe(true);
    expect(goalMet({ usedPct: 80 }, cfg, at(13)).met).toBe(false);
  });
  test("nothing safe left: a recent clean that freed less than the floor", () => {
    expect(goalMet({ usedPct: 92, lastRun: { at: at(13) - 3600_000, freedBytes: 2e8 } }, cfg, at(13)).met).toBe(true);
    expect(goalMet({ usedPct: 92, lastRun: { at: at(13) - 3600_000, freedBytes: 5e9 } }, cfg, at(13)).met).toBe(false);
    expect(goalMet({ usedPct: 92, lastRun: { at: at(13) - 7 * 3600_000, freedBytes: 0 } }, cfg, at(13)).met).toBe(false); // cooldown over
  });
});

/** A fake shell: answers by command prefix and records every call. `df` answers in order. */
function fakeSh(answers: Record<string, string>, dfUsed: number[]): Sh & { calls: string[][] } {
  const calls: string[][] = [];
  let df = 0;
  const sh = ((argv: string[]) => {
    calls.push(argv);
    const line = argv.join(" ");
    if (argv[0] === "df") return { code: 0, out: `1000000000000 ${dfUsed[Math.min(df++, dfUsed.length - 1)]}\n` };
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    return key ? { code: 0, out: answers[key]! } : { code: 0, out: "" };
  }) as Sh & { calls: string[][] };
  sh.calls = calls;
  return sh;
}

const INSPECT_IMAGES = JSON.stringify([
  { Id: "sha256:old", RepoTags: ["app:old"], RepoDigests: [], Created: new Date(NOW - 30 * DAY).toISOString() },
  { Id: "sha256:used", RepoTags: ["app:2"], RepoDigests: [], Created: new Date(NOW - 30 * DAY).toISOString() },
]);
const CACHE_MNT = mkdtempSync(join(tmpdir(), "disk-cachevol-"));
const INSPECT_CONTAINERS = JSON.stringify([
  {
    Id: "c-old",
    Name: "/old-job",
    Image: "sha256:used",
    Config: { Image: "app:2", Labels: {} },
    State: { Status: "exited", Running: false, FinishedAt: new Date(NOW - 20 * DAY).toISOString() },
    Mounts: [{ Type: "volume", Name: "keep-vol" }],
  },
  {
    Id: "c-svc",
    Name: "/travel-service",
    Image: "sha256:go",
    LogPath: "/var/lib/docker/containers/c-svc/c-svc-json.log",
    Config: { Image: "golang:1.26", Labels: {} },
    State: { Status: "running", Running: true, FinishedAt: "" },
    Mounts: [{ Type: "volume", Name: "svc_go_build_cache" }],
  },
]);
const VOLUMES = JSON.stringify({
  Volumes: [
    { Name: "trivy-cache", Size: "3.2GB", Labels: "", Links: "0" },
    { Name: "keep-vol", Size: "1GB", Links: "1" },
    { Name: "ws_postgres_data", Size: "2GB", Links: "0" },
    { Name: "svc_go_build_cache", Size: "30GB", Links: "1" },
  ],
});
const VOLUME_INSPECT = JSON.stringify([
  { Name: "trivy-cache", Driver: "local", Mountpoint: "/x/trivy", CreatedAt: new Date(NOW - 50 * DAY).toISOString(), Labels: null },
  { Name: "keep-vol", Driver: "local", Mountpoint: "/x/keep", CreatedAt: new Date(NOW - 50 * DAY).toISOString(), Labels: null },
  { Name: "ws_postgres_data", Driver: "local", Mountpoint: "/x/ws", CreatedAt: new Date(NOW - 50 * DAY).toISOString(), Labels: null },
  { Name: "svc_go_build_cache", Driver: "local", Mountpoint: CACHE_MNT, CreatedAt: new Date(NOW - 50 * DAY).toISOString(), Labels: null },
]);

const answers = {
  "docker image ls": "sha256:old\nsha256:used\n",
  "docker image inspect": INSPECT_IMAGES,
  "docker ps -aq": "c-old\nc-svc\n",
  "docker container inspect": INSPECT_CONTAINERS,
  "docker system df -v --format": VOLUMES,
  "docker volume ls": "trivy-cache\nkeep-vol\nws_postgres_data\nsvc_go_build_cache\n",
  "docker volume inspect": VOLUME_INSPECT,
};
const bare = { logRoots: [], tmpRoots: [], dumpRoots: [], projectsRoot: "/nonexistent", coredumpDir: "/nonexistent" };

describe("disk cleanup: a run", () => {
  test("Tier A runs in order, measures each category, never forces; Tier B is listed and state written", () => {
    const state = mkdtempSync(join(tmpdir(), "disk-state-"));
    mkdirSync(join(CACHE_MNT, "ab"), { recursive: true });
    writeFileSync(join(CACHE_MNT, "ab", "obj"), "x");
    mkdirSync(join(CACHE_MNT, "bin"), { recursive: true }); // a GOPATH volume: installed tools, not cache
    writeFileSync(join(CACHE_MNT, "bin", "air"), "x");
    // used bytes: the start, then after each of the 18 Tier A steps (dangling, images, build cache,
    // containers, unused volumes, cache volumes, container logs, journal, rotated logs, core dumps,
    // /tmp, build outputs, worktrees, bun, npm, go-build, go-mod, pip)
    const used = [920e9, 919e9, 915e9, 900e9, 899e9, 896e9, 866e9, 865e9, 865e9, 865e9, 865e9, 865e9, 865e9, 865e9, 865e9, 865e9, 865e9, 865e9, 865e9];
    const sh = fakeSh(answers, used);
    const out = runCleanup({ sh, cfg: { ...cfg, ...bare }, stateDir: state, now: NOW, keepDigests: new Set(), cwds: [], logBytes: (p) => (p.includes("c-svc") ? 2e9 : 0) });
    const lines = sh.calls.map((c) => c.join(" "));
    expect(lines).toContain("docker image prune -f");
    expect(lines).toContain("docker rmi app:old");
    expect(lines.some((l) => l.startsWith("docker rmi app:2"))).toBe(false); // a stopped container uses it
    expect(lines).toContain(`docker builder prune -af --filter until=${cfg.buildCacheMaxAgeHours}h`);
    expect(lines).toContain("docker rm c-old"); // no -v: its volumes stay
    expect(lines).toContain("docker volume rm trivy-cache");
    expect(lines).not.toContain("docker volume rm ws_postgres_data"); // may be real DB data
    // the cache wipe: stop, empty, start — the volume and the container stay
    const stop = lines.indexOf("docker stop c-svc");
    expect(stop).toBeGreaterThan(-1);
    expect(lines.indexOf("docker start c-svc")).toBeGreaterThan(stop);
    expect(lines).not.toContain("docker volume rm svc_go_build_cache");
    expect(readdirSync(CACHE_MNT)).toEqual(["bin"]);
    expect(existsSync(join(CACHE_MNT, "bin", "air"))).toBe(true);
    expect(existsSync(CACHE_MNT)).toBe(true);
    expect(lines).toContain("truncate -s 0 /var/lib/docker/containers/c-svc/c-svc-json.log");
    expect(lines).toContain("journalctl --vacuum-size=500M");
    const changing = lines.filter((l) => !l.startsWith("docker system df")); // -v there is verbose, read-only
    expect(changing.some((l) => /system prune|\brm -f\b|\s-v(\s|$)|--volumes|rmi -f|volume rm (-f|--force)|worktree remove (-f|--force)/.test(l))).toBe(false);
    expect(out.before.usedPct).toBe(92);
    expect(out.after.usedPct).toBe(86.5);
    expect(out.freed.find((f) => f.category === "build cache")!.bytes).toBe(15e9);
    expect(out.freed.find((f) => f.category === "cache volumes")!.bytes).toBe(30e9);
    expect(out.freedTotal).toBe(55e9);
    expect(out.candidates.map((c) => c.target)).toEqual(["ws_postgres_data"]);
    expect(JSON.parse(readFileSync(join(state, "last-run.json"), "utf8")).freedBytes).toBe(55e9);
    expect(JSON.parse(readFileSync(join(state, "candidates.json"), "utf8")).items).toHaveLength(1);
    expect(out.report).toContain("92% → 86.5%");
    expect(out.report).toContain(candidateId("volume", "ws_postgres_data"));
  });

  test("a container gone between `ps` and `inspect`: the rest is read from stdout; an unreadable inventory aborts before any change", () => {
    const state = mkdtempSync(join(tmpdir(), "disk-state-"));
    const base = fakeSh(answers, [920e9]);
    // docker prints the containers it found on stdout and the missing one on stderr, exit 1
    const raced: Sh = (argv, o) => (argv.join(" ").startsWith("docker container inspect") ? { code: 1, out: INSPECT_CONTAINERS, err: "Error: No such container: c-gone" } : base(argv, o));
    const out = runCleanup({ sh: raced, cfg: { ...cfg, ...bare }, stateDir: state, now: NOW, keepDigests: new Set(), cwds: [], logBytes: () => 0, dryRun: true });
    expect(out.report).toContain("svc_go_build_cache");

    const calls: string[] = [];
    const broken: Sh = (argv, o) => {
      calls.push(argv.join(" "));
      return argv.join(" ").startsWith("docker container inspect") ? { code: 1, out: "", err: "Cannot connect to the Docker daemon" } : base(argv, o);
    };
    expect(() => runCleanup({ sh: broken, cfg: { ...cfg, ...bare }, stateDir: state, now: NOW, keepDigests: new Set(), cwds: [], logBytes: () => 0 })).toThrow(/inventory/);
    const down: Sh = (argv, o) => {
      calls.push(argv.join(" "));
      return argv[0] === "docker" && argv[1] !== "system" ? { code: 1, out: "", err: "Cannot connect to the Docker daemon" } : base(argv, o);
    };
    expect(() => runCleanup({ sh: down, cfg: { ...cfg, ...bare }, stateDir: state, now: NOW, keepDigests: new Set(), cwds: [], logBytes: () => 0 })).toThrow(/inventory/);
    expect(calls.some((l) => /^(docker (rmi|rm|stop|volume rm|image prune|builder prune)|truncate|git .* worktree remove)/.test(l))).toBe(false);
  });

  test("a container that fails to start again after a wipe is named in the report", () => {
    const state = mkdtempSync(join(tmpdir(), "disk-state-"));
    const base = fakeSh(answers, [920e9]);
    const sh: Sh = (argv, o) => (argv[0] === "docker" && argv[1] === "start" ? { code: 1, out: "boom" } : base(argv, o));
    const out = runCleanup({ sh, cfg: { ...cfg, ...bare }, stateDir: state, now: NOW, keepDigests: new Set(), cwds: [], logBytes: () => 0 });
    expect(out.freed.find((f) => f.category === "cache volumes")!.detail).toContain("NOT restarted: travel-service");
  });

  test("a command that is not installed is reported as such, and a cwd is passed through", () => {
    const state = mkdtempSync(join(tmpdir(), "disk-state-"));
    const seen: Array<{ argv: string[]; cwd?: string }> = [];
    const sh: Sh = (argv, opts) => {
      seen.push({ argv, cwd: opts?.cwd });
      if (argv[0] === "df") return { code: 0, out: "1000 900\n" };
      if (argv[0] === "go") return { code: 127, out: "go: not found" };
      return { code: 0, out: "" };
    };
    const caches = [{ name: "bun", argv: ["bun", "pm", "cache", "rm"], cwd: "/kit" }, { name: "go-build", argv: ["go", "clean", "-cache"] }];
    const out = runCleanup({ sh, cfg: { ...cfg, ...bare, packageCaches: caches }, stateDir: state, now: NOW, keepDigests: new Set(), cwds: [], logBytes: () => 0 });
    expect(seen.find((c) => c.argv[0] === "bun")!.cwd).toBe("/kit");
    expect(out.freed.find((f) => f.category === "go-build cache")!.detail).toBe("not installed");
  });

  test("--dry-run changes nothing and writes no last run", () => {
    const state = mkdtempSync(join(tmpdir(), "disk-state-"));
    rmSync(join(CACHE_MNT, "bin"), { recursive: true, force: true });
    writeFileSync(join(CACHE_MNT, "keep-me"), "x");
    const sh = fakeSh(answers, [920e9]);
    const out = runCleanup({ sh, cfg: { ...cfg, ...bare }, stateDir: state, now: NOW, keepDigests: new Set(), dryRun: true, cwds: [], logBytes: () => 2e9 });
    const lines = sh.calls.map((c) => c.join(" "));
    expect(lines.some((l) => /^(docker (rmi|rm|stop|start|volume rm|image prune|builder prune)|truncate|journalctl --vacuum|bun pm|npm cache|go clean|pip3 cache)/.test(l))).toBe(false);
    expect(readdirSync(CACHE_MNT)).toEqual(["keep-me"]);
    expect(out.report).toContain("svc_go_build_cache");
    expect(existsSync(join(state, "last-run.json"))).toBe(false);
    expect(out.report).toContain("dry run");
    expect(out.report).toContain("docker rmi app:old");
    expect(out.report).not.toContain("candidates.json"); // a dry run writes no list to point at
  });
});

describe("disk cleanup: deleting approved Tier B items", () => {
  test("only approved ids, checked again first; a volume now in use, a protected or an unknown id is refused", () => {
    const state = mkdtempSync(join(tmpdir(), "disk-state-"));
    const dir = mkdtempSync(join(tmpdir(), "disk-dump-"));
    const dump = join(dir, "old.sql.gz");
    writeFileSync(dump, "x");
    const items: Candidate[] = [
      { id: candidateId("volume", "trivy-cache"), kind: "volume", target: "trivy-cache", bytes: 3e9, lastUsed: NOW, project: "-" },
      { id: candidateId("volume", "now-used"), kind: "volume", target: "now-used", bytes: 1e9, lastUsed: NOW, project: "-" },
      { id: candidateId("dump", dump), kind: "dump", target: dump, bytes: 1e9, lastUsed: NOW, project: "-" },
      { id: candidateId("dump", "/home/neo/data/x.sql"), kind: "dump", target: "/home/neo/data/x.sql", bytes: 1e9, lastUsed: NOW, project: "neo" },
      { id: candidateId("dump", "/tmp/not-approved.sql"), kind: "dump", target: "/tmp/not-approved.sql", bytes: 1e9, lastUsed: NOW, project: "-" },
    ];
    writeFileSync(join(state, "candidates.json"), JSON.stringify({ at: NOW, items }));
    const sh = fakeSh({ ...answers, "docker container inspect": JSON.stringify([{ Id: "c9", Name: "/x", Image: "i", Config: { Image: "i", Labels: {} }, State: { Status: "running", Running: true, FinishedAt: "" }, Mounts: [{ Type: "volume", Name: "now-used" }] }]), "docker ps -aq": "c9\n" }, [1]);
    const ids = [items[0]!.id, items[1]!.id, items[2]!.id, items[3]!.id, "b-nope"];
    const res = deleteApproved(ids, { sh, cfg, stateDir: state });
    const lines = sh.calls.map((c) => c.join(" "));
    expect(lines).toContain("docker volume rm trivy-cache");
    expect(lines).not.toContain("docker volume rm now-used");
    expect(existsSync(dump)).toBe(false);
    expect(res.find((r) => r.id === items[1]!.id)!.result).toMatch(/in use/);
    expect(res.find((r) => r.id === items[3]!.id)!.result).toMatch(/protected/);
    expect(res.find((r) => r.id === "b-nope")!.result).toMatch(/unknown/);
    expect(res.some((r) => r.id === items[4]!.id)).toBe(false); // never approved, never touched
  });
});

describe("disk cleanup: install", () => {
  test("copies the kit, keeps the host's config.json and state on a re-install", () => {
    const src = mkdtempSync(join(tmpdir(), "disk-src-"));
    const dest = join(mkdtempSync(join(tmpdir(), "disk-dest-")), "disk");
    writeFileSync(join(src, "cleanup.ts"), "// v1\n");
    installDiskKit({ src, dest });
    writeFileSync(join(dest, "config.json"), '{"alertPct":60}');
    mkdirSync(join(dest, "state"));
    writeFileSync(join(dest, "state", "last-run.json"), "{}");
    writeFileSync(join(src, "cleanup.ts"), "// v2\n");
    installDiskKit({ src, dest });
    expect(readFileSync(join(dest, "cleanup.ts"), "utf8")).toBe("// v2\n");
    expect(readFileSync(join(dest, "config.json"), "utf8")).toBe('{"alertPct":60}');
    expect(existsSync(join(dest, "state", "last-run.json"))).toBe(true);
  });

  test("a package-cache cwd resolves against the kit (bun needs a project folder)", () => {
    expect(cfg.packageCaches.find((p) => p.name === "bun")!.cwd).toBe(KIT);
    expect(existsSync(join(KIT, "package.json"))).toBe(true);
  });

  test("a host config.json overrides the defaults", () => {
    const kit = mkdtempSync(join(tmpdir(), "disk-kit-"));
    writeFileSync(join(kit, "defaults.json"), readFileSync(join(KIT, "defaults.json")));
    writeFileSync(join(kit, "config.json"), '{"alertPct":60}');
    expect(loadDiskConfig(kit).alertPct).toBe(60);
    expect(loadDiskConfig(kit).dailyHour).toBe(4);
  });
});
