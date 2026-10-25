import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scan.sh driven end to end with a fake `docker` on PATH (ADR-0051). The fake semgrep reports one
// finding per file and "times out" (exit 124, no output) on a part holding a file named *slow*.
const SCAN = join(import.meta.dir, "..", "tools", "security", "scan.sh");
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  info|rm) exit 0 ;;
  inspect) exit 1 ;;
  run) exit 0 ;;
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

function setup(files: string[], config: Record<string, unknown> = {}) {
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
    Bun.spawnSync(["bash", SCAN, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log } });
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
