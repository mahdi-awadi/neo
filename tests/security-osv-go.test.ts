import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// osv-go.sh, the script scan.sh runs inside the pinned Go image (ADR-0066), driven on the host with a
// fake `wget` (serves the osv binary) and a fake `go` (prints a module list for the folder it runs in).
const SCRIPT = join(import.meta.dir, "..", "tools", "security", "osv-go.sh");

function setup(osvBody = '#!/bin/sh\necho "{\\"args\\":\\"$*\\"}"\n') {
  const dir = mkdtempSync(join(tmpdir(), "neo-sec-osvgo-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const served = join(dir, "served-osv");
  writeFileSync(served, osvBody);
  writeFileSync(join(bin, "wget"), `#!/bin/sh\necho wget >> "${dir}/calls"\nwhile [ $# -gt 0 ]; do [ "$1" = -O ] && out=$2; shift; done\ncp "${served}" "$out"\n`);
  writeFileSync(join(bin, "go"), `#!/bin/sh\necho "go $* in $(pwd)" >> "${dir}/calls"\nprintf 'example.com/%s \\n' "$(basename "$(pwd)")"\nprintf 'golang.org/x/crypto v0.58.0\\n'\nprintf 'golang.org/x/net v0.1.0 golang.org/x/net v0.2.0\\n'\n`);
  for (const f of ["wget", "go"]) chmodSync(join(bin, f), 0o755);
  const repo = join(dir, "repo");
  const mods = [join(repo, "svc|a&b"), join(repo, "common")];
  for (const m of mods) mkdirSync(m, { recursive: true });
  writeFileSync(join(dir, "modules.txt"), `${mods.join("\n")}\n`);
  const sha = createHash("sha256").update(osvBody).digest("hex");
  const run = (shaPin = sha) =>
    Bun.spawnSync(["sh", SCRIPT, repo, join(dir, "modules.txt"), join(dir, "versions.txt"), join(dir, "cache")], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OSV_BIN_URL: "https://example.invalid/osv", OSV_BIN_SHA256: shaPin },
    });
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "");
  return { dir, repo, mods, sha, run, calls, served };
}

describe("osv-go.sh (ADR-0066)", () => {
  test("downloads the pinned binary once, writes each module's selected versions, runs osv on the repo", () => {
    const s = setup();
    const r = s.run();
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).args).toBe(`scan source -r --format json ${s.repo}`);
    const versions = readFileSync(join(s.dir, "versions.txt"), "utf8").trim().split("\n");
    expect(versions).toContain(`${s.mods[0]}/go.mod golang.org/x/crypto v0.58.0`); // a | or & in the path is kept as is
    expect(versions).toContain(`${s.mods[1]}/go.mod golang.org/x/net v0.1.0 golang.org/x/net v0.2.0`);
    expect(s.calls()).toContain("go list -m -f");
    s.run();
    expect(s.calls().split("\n").filter((l) => l === "wget")).toHaveLength(1); // cached and re-checked
  });

  test("a download that does not match the pinned checksum is refused: exit 97, nothing runs or stays", () => {
    const s = setup();
    const r = s.run("0".repeat(64));
    expect(r.exitCode).toBe(97);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toContain("does not match");
    expect(readdirSync(join(s.dir, "cache", "bin"))).toEqual([]);
  });

  test("a cached binary that no longer matches is fetched again", () => {
    const s = setup();
    s.run();
    writeFileSync(join(s.dir, "cache", "bin", `osv-scanner-${s.sha}`), "#!/bin/sh\necho tampered\n");
    const r = s.run();
    expect(r.stdout.toString()).not.toContain("tampered");
    expect(s.calls().split("\n").filter((l) => l === "wget")).toHaveLength(2);
  });
});
