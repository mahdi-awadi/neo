import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scan.sh driven end to end with a fake `docker` on PATH (ADR-0051). The fake semgrep reports one
// finding per file and "times out" (exit 124, no output) on a part holding a file named *slow*.
const SCAN = join(import.meta.dir, "..", "tools", "security", "scan.sh");
const FAKE_DOCKER = `#!/usr/bin/env bash
args="$*"; echo "\${args//$'\\n'/ }" >> "$FAKE_DOCKER_LOG" # one line per call
case "$1" in
  info|rm) exit 0 ;;
  inspect) exit 1 ;;
  run)
    if [[ " $* " == *" --entrypoint sh "* ]]; then # the osv run with Go call analysis (ADR-0066)
      for a in "$@"; do [[ "$a" == */osv-meta:/meta && -n "\${FAKE_OSV_GO_VERSIONS:-}" ]] && cp "$FAKE_OSV_GO_VERSIONS" "\${a%:/meta}/go-versions.txt"; done
      [[ -n "\${FAKE_OSV_GO_JSON:-}" ]] && cat "$FAKE_OSV_GO_JSON"
    fi
    exit 0 ;;
  exec)
    shift
    if [[ "$1" == "-i" ]]; then cat >/dev/null; exit 0; fi
    if [[ "$1" == "-w" ]]; then
      shift 3 # -w <dir> <container>
      [[ "$1" == timeout && "$3" == semgrep ]] || exit 0
      files=(); for a in "$@"; do [[ "$a" == src/* ]] && files+=("$a"); done
      echo "part \${#files[@]} \${files[*]}" >> "$FAKE_DOCKER_LOG"
      for f in "\${files[@]}"; do [[ "$f" == *slow* ]] && exit 124; done
      sep=""; printf '{"results":['
      for f in "\${files[@]}"; do
        printf '%s{"check_id":"r.x","path":"%s","start":{"line":1},"extra":{"severity":"ERROR","message":"m","lines":"%s"}}' "$sep" "$f" "$f"; sep=","
      done
      printf ']}'
      exit 1
    fi
    exit 0 ;;
esac
exit 0
`;

function setup(files: string[], config: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}) {
  const repo = mkdtempSync(join(tmpdir(), "neo-sec-scan-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  mkdirSync(join(repo, "src"));
  for (const f of files) writeFileSync(join(repo, f), "export const x = 1;\n");
  Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
  Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  // Untracked, so the scanned files are exactly `files`.
  mkdirSync(join(repo, ".security"));
  writeFileSync(join(repo, ".security", "config.json"), JSON.stringify({ devUrls: [], images: [], testCmd: "", ...config }));
  const bin = mkdtempSync(join(tmpdir(), "neo-sec-bin-"));
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const log = join(bin, "log");
  writeFileSync(log, "");
  const run = (...args: string[]) =>
    Bun.spawnSync(["bash", SCAN, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, ...extraEnv } });
  return { repo, run, log: () => readFileSync(log, "utf8") };
}

const baselineOf = (repo: string) => JSON.parse(readFileSync(join(repo, ".security", "baseline.json"), "utf8"));
const parts = (log: string) => log.split("\n").filter((l) => l.startsWith("part "));

describe("security scan: semgrep in parts (ADR-0051)", () => {
  test("files are scanned in parts of semgrepChunkFiles, each under semgrepTimeoutSec", () => {
    const s = setup(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], { semgrepChunkFiles: 2, semgrepTimeoutSec: 7 });
    expect(s.run("baseline", s.repo).exitCode).toBe(0);
    expect(parts(s.log()).map((l) => Number(l.split(" ")[1]))).toEqual([2, 2, 1]);
    expect(s.log()).toContain("timeout 7 semgrep");
    const b = baselineOf(s.repo);
    expect(b.findings.filter((f: { tool: string }) => f.tool === "semgrep")).toHaveLength(5);
    expect(b.incomplete.filter((m: { tool: string }) => m.tool === "semgrep")).toEqual([]);
  });

  test("defaults: 200 files a part, 1800 s; an invalid value falls back to the default", () => {
    const s = setup(["src/a.ts", "src/b.ts"], { semgrepChunkFiles: "2; touch /tmp/x", semgrepTimeoutSec: -5 });
    expect(s.run("baseline", s.repo).exitCode).toBe(0);
    expect(parts(s.log()).map((l) => Number(l.split(" ")[1]))).toEqual([2]);
    expect(s.log()).toContain("timeout 1800 semgrep");
  });

  test("a part that times out is a missing part; the other parts' findings are kept", () => {
    const s = setup(["src/a.ts", "src/b.ts", "src/slow.ts", "src/d.ts"], { semgrepChunkFiles: 2 });
    expect(s.run("baseline", s.repo).exitCode).toBe(0);
    const b = baselineOf(s.repo);
    expect(b.findings.filter((f: { tool: string }) => f.tool === "semgrep").map((f: { file: string }) => f.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const missing = b.incomplete.filter((m: { tool: string }) => m.tool === "semgrep");
    expect(missing).toHaveLength(1);
    expect(missing[0].detail).toContain("part 2/2");
  });

  test("a gitleaks history scan with no report is a missing part", () => {
    const s = setup(["src/a.ts"]);
    s.run("baseline", s.repo);
    expect(baselineOf(s.repo).incomplete.map((m: { tool: string }) => m.tool)).toContain("gitleaks");
  });

  test("a scan against an incomplete baseline warns; the report lists its own missing parts", () => {
    const s = setup(["src/a.ts", "src/slow.ts"], { semgrepChunkFiles: 1 });
    s.run("baseline", s.repo);
    const r = s.run("file", s.repo, join(s.repo, "src", "slow.ts"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString() + r.stderr.toString()).toMatch(/baseline is incomplete/);
    const dir = join(s.repo, ".security", "reports");
    expect(existsSync(dir)).toBe(true);
    const name = Bun.spawnSync(["ls", dir]).stdout.toString().trim().split("\n").find((n) => n.startsWith("write-"))!;
    const report = JSON.parse(readFileSync(join(dir, name), "utf8"));
    expect(report.incomplete.map((m: { tool: string }) => m.tool)).toContain("semgrep");
  });
});

describe("security scan: osv with Go call analysis (ADR-0066)", () => {
  const osvRuns = (log: string) => log.split("\n").filter((l) => l.startsWith("run ") && l.includes("scan source"));
  const goRun = (log: string) => osvRuns(log).find((l) => l.includes("--entrypoint sh"));
  const plainRun = (log: string) => osvRuns(log).find((l) => !l.includes("--entrypoint sh"));

  test("osv runs in the pinned Go image on a copy-on-write overlay of the repo, at the repo's own path", () => {
    const s = setup(["src/a.ts"], { osvMemoryMb: 2048 });
    s.run("push", s.repo);
    const go = goRun(s.log())!;
    const images = readFileSync(join(import.meta.dir, "..", "tools", "security", "images.env"), "utf8");
    const pin = (k: string) => images.match(new RegExp(`^${k}=(.+)$`, "m"))![1]!;
    expect(go).toContain(pin("GO_IMAGE"));
    expect(go).toContain(`OSV_BIN_SHA256=${pin("OSV_BIN_SHA256")}`);
    expect(go).toContain("--memory 2048m --memory-swap 2048m -e GOMEMLIMIT=1740MiB");
    expect(go).toContain("neo-sec-gocache:/neo");
    expect(go).toContain(`dst=${s.repo},volume-driver=local,volume-opt=type=overlay`);
    expect(go).toMatch(new RegExp(`lowerdir=${s.repo},upperdir=/tmp/neo-sec\\.\\w+/osv-up,workdir=`)); // writes go to the scan's temp dir
    expect(go).not.toContain(`${s.repo}:${s.repo}`);
    expect(go).toContain("go work use -r ."); // a go.work grows to every module, inside the overlay only
  });

  test("a repo path the overlay mount options cannot hold: no Go run, the plain scan", () => {
    const s = setup(["src/a.ts"]);
    const odd = `${s.repo},x`;
    Bun.spawnSync(["mv", s.repo, odd]);
    const r = s.run("push", odd);
    expect(goRun(s.log())).toBeUndefined();
    expect(plainRun(s.log())).toContain(`${odd}:${odd}:ro`);
    expect(r.stderr.toString()).toContain("overlay mount cannot take");
  });

  test("no result with Go: the plain osv image scans read-only, so every finding keeps its full severity", () => {
    const s = setup(["src/a.ts"]);
    const r = s.run("push", s.repo);
    expect(plainRun(s.log())).toContain(`${s.repo}:${s.repo}:ro`);
    expect(r.stderr.toString()).toContain("Go call analysis gave no result");
  });

  test("a result with Go: no second osv run", () => {
    const out = join(mkdtempSync(join(tmpdir(), "neo-sec-osv-")), "osv.json");
    writeFileSync(out, JSON.stringify({ results: [] }));
    const s = setup(["src/a.ts"], {}, { FAKE_OSV_GO_JSON: out });
    s.run("push", s.repo);
    expect(goRun(s.log())).toContain("--memory 8192m --memory-swap 8192m"); // the default
    expect(plainRun(s.log())).toBeUndefined();
  });

  test("end to end: an uncalled Go vulnerability at the analysed version is reported as medium, unreachable", () => {
    const env: Record<string, string> = {};
    const s = setup(["src/a.ts"], {}, env); // env is read on each run
    const dir = mkdtempSync(join(tmpdir(), "neo-sec-osv-"));
    const gomod = `${s.repo}/go.mod`;
    const group = (id: string) => ({ ids: [id], aliases: [id], max_severity: "", experimental_analysis: { [id]: { called: false, unimportant: false } } });
    writeFileSync(join(dir, "osv.json"), JSON.stringify({ results: [{ source: { path: gomod }, packages: [
      { package: { name: "golang.org/x/crypto", version: "0.58.0", ecosystem: "Go" }, groups: [group("GO-2026-5932")] },
      { package: { name: "golang.org/x/net", version: "0.1.0", ecosystem: "Go" }, groups: [group("GO-2026-0001")] },
    ] }] }));
    // x/net was analysed at another version than the go.mod's: its verdict does not count.
    writeFileSync(join(dir, "versions.txt"), `${gomod} golang.org/x/crypto v0.58.0\n${gomod} golang.org/x/net v0.2.0\n`);
    Object.assign(env, { FAKE_OSV_GO_JSON: join(dir, "osv.json"), FAKE_OSV_GO_VERSIONS: join(dir, "versions.txt") });
    const out = s.run("push", s.repo).stdout.toString();
    expect(out).toMatch(/MEDIUM\s+go\.mod\s+\[osv:GO-2026-5932\] unreachable \(never called\)/);
    expect(out).toMatch(/HIGH\s+go\.mod\s+\[osv:GO-2026-0001\] golang\.org\/x\/net/);
  });
});
