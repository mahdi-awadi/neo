import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateId,
  deleteApproved,
  goalMet,
  isProtected,
  isRotatedLog,
  loadDiskConfig,
  parseKeepDigests,
  pickContainers,
  pickImages,
  runCleanup,
  tmpVictims,
  volumeCandidates,
  type Candidate,
  type ContainerInfo,
  type ImageInfo,
  type Sh,
  type VolumeInfo,
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
      img({ id: "young", tags: ["app:3"], created: NOW - 2 * DAY }),
      img({ id: "prod", tags: ["eticket-prod-api:latest"] }),
      img({ id: "pinned", tags: ["semgrep/semgrep:1"], digests: ["semgrep/semgrep@sha256:aa11"] }),
      img({ id: "dangling", tags: [] }), // `docker image prune` handles these
    ];
    const containers = [ctr({ image: "used-by-stopped", running: false })];
    expect(pickImages(images, containers, new Set(["sha256:aa11"]), cfg, NOW).map((i) => i.id)).toEqual(["old-unused"]);
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
    expect(tmpVictims(root, cfg, now).sort()).toEqual([nested, victim].sort());
  });
});

describe("disk cleanup: Tier B candidates", () => {
  const vol = (o: Partial<VolumeInfo>): VolumeInfo => ({ name: "v", created: NOW - 60 * DAY, bytes: 3e9, ...o });

  test("unused, unprotected volumes above the size floor, with a stable id", () => {
    const vols = [
      vol({ name: "trivy-cache" }),
      vol({ name: "in-use" }),
      vol({ name: "used-by-stopped" }),
      vol({ name: "eticket-prod_pg" }),
      vol({ name: "tiny", bytes: 1000 }),
      vol({ name: "ws_db", project: "ws" }),
    ];
    const cs = [ctr({ running: true, volumes: ["in-use"] }), ctr({ volumes: ["used-by-stopped"] })];
    const got = volumeCandidates(vols, cs, cfg);
    expect(got.map((c) => c.target)).toEqual(["trivy-cache", "ws_db"]);
    expect(got[0]).toMatchObject({ kind: "volume", bytes: 3e9, project: "-", id: candidateId("volume", "trivy-cache") });
    expect(got[1]!.project).toBe("ws");
    expect(candidateId("volume", "trivy-cache")).toBe(candidateId("volume", "trivy-cache"));
    expect(candidateId("volume", "trivy-cache")).not.toBe(candidateId("dump", "trivy-cache"));
  });
});

describe("disk cleanup: the goal", () => {
  const at = (hour: number) => Date.parse(`2026-10-17T${String(hour).padStart(2, "0")}:30:00`); // server-local

  test("under the target: met", () => {
    expect(goalMet({ usedPct: 65 }, cfg, at(4)).met).toBe(true);
  });
  test("outside the daily hour: met while under the alert level, not over it", () => {
    expect(goalMet({ usedPct: 75 }, cfg, at(13)).met).toBe(true);
    expect(goalMet({ usedPct: 85 }, cfg, at(13)).met).toBe(false);
  });
  test("in the daily hour: not met above the target", () => {
    expect(goalMet({ usedPct: 75 }, cfg, at(4)).met).toBe(false);
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
const INSPECT_CONTAINERS = JSON.stringify([
  {
    Id: "c-old",
    Name: "/old-job",
    Image: "sha256:used",
    Config: { Image: "app:2", Labels: {} },
    State: { Status: "exited", Running: false, FinishedAt: new Date(NOW - 20 * DAY).toISOString() },
    Mounts: [{ Type: "volume", Name: "keep-vol" }],
  },
]);
const VOLUMES = JSON.stringify({ Volumes: [{ Name: "trivy-cache", Size: "3.2GB", Labels: "", Links: "0" }, { Name: "keep-vol", Size: "1GB", Links: "1" }] });
const VOLUME_INSPECT = JSON.stringify([
  { Name: "trivy-cache", CreatedAt: new Date(NOW - 50 * DAY).toISOString(), Labels: null },
  { Name: "keep-vol", CreatedAt: new Date(NOW - 50 * DAY).toISOString(), Labels: null },
]);

const answers = {
  "docker image ls": "sha256:old\nsha256:used\n",
  "docker image inspect": INSPECT_IMAGES,
  "docker ps -aq": "c-old\n",
  "docker container inspect": INSPECT_CONTAINERS,
  "docker system df -v --format": VOLUMES,
  "docker volume ls": "trivy-cache\nkeep-vol\n",
  "docker volume inspect": VOLUME_INSPECT,
};

describe("disk cleanup: a run", () => {
  test("Tier A runs in order, measures each category, never removes volumes or forces; Tier B is listed and state written", () => {
    const state = mkdtempSync(join(tmpdir(), "disk-state-"));
    // used bytes: the start, then after each of the 11 Tier A steps (dangling, images, build cache,
    // containers, journal, logs, /tmp, bun, npm, go-build, pip)
    const sh = fakeSh(answers, [920e9, 919e9, 915e9, 900e9, 899e9, 899e9, 898e9, 896e9, 895e9, 895e9, 895e9, 895e9]);
    const out = runCleanup({ sh, cfg: { ...cfg, logRoots: [], tmpRoots: [], dumpRoots: [], projectsRoot: "/nonexistent" }, stateDir: state, now: NOW, keepDigests: new Set() });
    const lines = sh.calls.map((c) => c.join(" "));
    expect(lines).toContain("docker image prune -f");
    expect(lines).toContain("docker rmi app:old");
    expect(lines.some((l) => l.startsWith("docker rmi app:2"))).toBe(false); // a stopped container uses it
    expect(lines).toContain("docker builder prune -f --filter until=168h");
    expect(lines).toContain("docker rm c-old"); // no -v: its volumes stay
    expect(lines).toContain("journalctl --vacuum-size=500M");
    const changing = lines.filter((l) => !l.startsWith("docker system df")); // -v there is verbose, read-only
    expect(changing.some((l) => /volume rm|system prune|\brm -f\b|\s-v(\s|$)|--volumes|rmi -f/.test(l))).toBe(false);
    expect(out.before.usedPct).toBe(92);
    expect(out.after.usedPct).toBe(89.5);
    expect(out.freed.find((f) => f.category === "build cache")!.bytes).toBe(15e9);
    expect(out.freedTotal).toBe(25e9);
    expect(out.candidates.map((c) => c.target)).toEqual(["trivy-cache"]);
    expect(JSON.parse(readFileSync(join(state, "last-run.json"), "utf8")).freedBytes).toBe(25e9);
    expect(JSON.parse(readFileSync(join(state, "candidates.json"), "utf8")).items).toHaveLength(1);
    expect(out.report).toContain("92% → 89.5%");
    expect(out.report).toContain(candidateId("volume", "trivy-cache"));
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
    const out = runCleanup({ sh, cfg: { ...cfg, packageCaches: caches, logRoots: [], tmpRoots: [], dumpRoots: [], projectsRoot: "/nonexistent" }, stateDir: state, now: NOW, keepDigests: new Set() });
    expect(seen.find((c) => c.argv[0] === "bun")!.cwd).toBe("/kit");
    expect(out.freed.find((f) => f.category === "go-build cache")!.detail).toBe("not installed");
  });

  test("--dry-run changes nothing and writes no last run", () => {
    const state = mkdtempSync(join(tmpdir(), "disk-state-"));
    const sh = fakeSh(answers, [920e9]);
    const out = runCleanup({ sh, cfg: { ...cfg, logRoots: [], tmpRoots: [], dumpRoots: [], projectsRoot: "/nonexistent" }, stateDir: state, now: NOW, keepDigests: new Set(), dryRun: true });
    const lines = sh.calls.map((c) => c.join(" "));
    expect(lines.some((l) => /^(docker (rmi|rm|image prune|builder prune)|journalctl --vacuum|bun pm|npm cache|go clean|pip3 cache)/.test(l))).toBe(false);
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
    writeFileSync(join(dest, "config.json"), '{"targetPct":60}');
    mkdirSync(join(dest, "state"));
    writeFileSync(join(dest, "state", "last-run.json"), "{}");
    writeFileSync(join(src, "cleanup.ts"), "// v2\n");
    installDiskKit({ src, dest });
    expect(readFileSync(join(dest, "cleanup.ts"), "utf8")).toBe("// v2\n");
    expect(readFileSync(join(dest, "config.json"), "utf8")).toBe('{"targetPct":60}');
    expect(existsSync(join(dest, "state", "last-run.json"))).toBe(true);
  });

  test("a package-cache cwd resolves against the kit (bun needs a project folder)", () => {
    expect(cfg.packageCaches.find((p) => p.name === "bun")!.cwd).toBe(KIT);
    expect(existsSync(join(KIT, "package.json"))).toBe(true);
  });

  test("a host config.json overrides the defaults", () => {
    const kit = mkdtempSync(join(tmpdir(), "disk-kit-"));
    writeFileSync(join(kit, "defaults.json"), readFileSync(join(KIT, "defaults.json")));
    writeFileSync(join(kit, "config.json"), '{"targetPct":60}');
    expect(loadDiskConfig(kit).targetPct).toBe(60);
    expect(loadDiskConfig(kit).alertPct).toBe(80);
  });
});
