import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterNew, incompleteWarning, normalize, parseGoVersions, parseMissing, severityFromCvss, summarize } from "../tools/security/findings";

describe("security findings", () => {
  test("semgrep ERROR maps to high, WARNING to medium, fingerprint ignores line numbers", () => {
    const raw = {
      results: [
        { check_id: "r.sqli", path: "a.ts", start: { line: 3 }, extra: { severity: "ERROR", message: "sqli", lines: "  db.query(x)  " } },
        { check_id: "r.weak", path: "a.ts", start: { line: 9 }, extra: { severity: "WARNING", message: "weak", lines: "md5()" } },
      ],
    };
    const f = normalize("semgrep", raw);
    expect(f.map((x) => x.severity)).toEqual(["high", "medium"]);
    const moved = normalize("semgrep", { results: [{ ...raw.results[0], start: { line: 40 } }] });
    expect(moved[0].fingerprint).toBe(f[0].fingerprint);
  });

  test("semgrep metadata confidence/impact HIGH upgrades a WARNING", () => {
    const f = normalize("semgrep", {
      results: [{ check_id: "x", path: "b.go", start: { line: 1 }, extra: { severity: "WARNING", message: "m", lines: "l", metadata: { impact: "HIGH", confidence: "HIGH" } } }],
    });
    expect(f[0].severity).toBe("high");
  });

  test("every gitleaks finding is critical and the secret never appears in the output", () => {
    const f = normalize("gitleaks", [{ RuleID: "aws", File: ".env.prod", StartLine: 2, Secret: "AKIASECRET", Match: "key=AKIASECRET", Commit: "abc" }]);
    expect(f[0].severity).toBe("critical");
    expect(JSON.stringify(f)).not.toContain("AKIASECRET");
  });

  test("osv groups map by CVSS score", () => {
    expect(severityFromCvss("9.8")).toBe("critical");
    expect(severityFromCvss("7.5")).toBe("high");
    expect(severityFromCvss("5")).toBe("medium");
    expect(severityFromCvss("")).toBe("high"); // unknown score fails closed
    const f = normalize("osv", {
      results: [{ source: { path: "/src/bun.lock" }, packages: [{ package: { name: "lodash", version: "4.17.0", ecosystem: "npm" }, groups: [{ ids: ["GHSA-1"], max_severity: "7.4" }] }] }],
    });
    expect(f[0]).toMatchObject({ severity: "high", rule: "GHSA-1", file: "/src/bun.lock" });
  });

  describe("osv Go call analysis (ADR-0066)", () => {
    const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "security", `osv-${name}.json`), "utf8"));
    const by = (f: ReturnType<typeof normalize>, pkg: string) => f.find((x) => x.message.includes(`${pkg}@`))!;
    const versionsText = readFileSync(join(import.meta.dir, "fixtures", "security", "osv-go-versions.txt"), "utf8");
    // The module versions Go selected when it analysed each go.mod (scan.sh writes them).
    const ctx = (text = versionsText) => ({ root: "/repo", goVersions: parseGoVersions(text, "/repo") });

    test("a Go vulnerability osv found uncalled drops below the blocking level, tagged and still reported", () => {
      const f = normalize("osv", fixture("go-uncalled"), ctx());
      expect(f).toHaveLength(3);
      const crypto = by(f, "golang.org/x/crypto");
      expect(crypto).toMatchObject({ rule: "GO-2026-5932", severity: "medium", tags: ["unreachable"], file: "services/common/go.mod" });
      expect(crypto.message).toContain("unreachable");
      // osv keys the verdict by the Go id only; the GHSA id in the group is its alias.
      expect(by(f, "github.com/quic-go/quic-go")).toMatchObject({ severity: "medium", tags: ["unreachable"] }); // was critical (9.1)
      expect(by(f, "github.com/jackc/pgx/v5")).toMatchObject({ severity: "low", tags: ["unreachable"] }); // never raised
      expect(summarize(f).block).toBe(false);
    });

    test("a called vulnerability keeps its full severity", () => {
      const f = normalize("osv", fixture("go-called"), ctx());
      expect(by(f, "golang.org/x/crypto")).toMatchObject({ severity: "high" }); // no score: fails closed to high
      expect(by(f, "github.com/quic-go/quic-go")).toMatchObject({ severity: "critical" });
      for (const x of f) expect(x.tags).toBeUndefined();
      expect(summarize(f).block).toBe(true);
    });

    test("fails closed: no analysis, a verdict for another id, a non-boolean verdict, or a non-Go ecosystem keep full severity", () => {
      const f = normalize("osv", fixture("go-no-analysis"), ctx());
      expect(by(f, "golang.org/x/crypto").severity).toBe("high");
      expect(by(f, "github.com/quic-go/quic-go").severity).toBe("critical");
      expect(by(f, "golang.org/x/net").severity).toBe("high");
      expect(by(f, "lodash").severity).toBe("high");
      for (const x of f) expect(x.tags).toBeUndefined();
    });

    test("the verdict never changes a fingerprint, so a baseline still matches", () => {
      const fp = (name: string) => by(normalize("osv", fixture(name), ctx()), "golang.org/x/crypto").fingerprint;
      expect(fp("go-uncalled")).toBe(fp("go-called"));
      expect(by(normalize("osv", fixture("go-uncalled"), { root: "/repo" }), "golang.org/x/crypto").fingerprint).toBe(fp("go-called"));
    });

    test("fails closed: a verdict counts only for the version osv reported, as Go selected it for that go.mod", () => {
      const sev = (c: ReturnType<typeof ctx> | { root: string }, pkg = "golang.org/x/crypto") => by(normalize("osv", fixture("go-uncalled"), c), pkg).severity;
      expect(sev({ root: "/repo" })).toBe("high"); // no versions: the Go run did not report them
      expect(sev(ctx(""))).toBe("high");
      // A workspace selected a newer x/crypto than this go.mod asks for: the verdict is about other code.
      const newer = versionsText.replace("/repo/services/common/go.mod golang.org/x/crypto v0.58.0", "/repo/services/common/go.mod golang.org/x/crypto v0.60.0");
      expect(sev(ctx(newer))).toBe("high");
      expect(sev(ctx(newer), "github.com/quic-go/quic-go")).toBe("medium"); // the others still count
      // Replaced by another version or a local folder: not the reported version.
      const swap = (to: string) => versionsText.replace("golang.org/x/crypto v0.58.0\n/repo/services/common/go.mod github.com/quic", `golang.org/x/crypto v0.58.0 ${to}\n/repo/services/common/go.mod github.com/quic`);
      expect(sev(ctx(swap("golang.org/x/crypto v0.59.0")))).toBe("high");
      expect(sev(ctx(swap("../crypto")))).toBe("high");
      expect(sev(ctx(swap("golang.org/x/crypto v0.58.0")))).toBe("medium");
      // The standard library is analysed with the image's Go, not the go.mod's: never in the list.
      const stdlib = { results: [{ source: { path: "/repo/services/common/go.mod" }, packages: [{ package: { name: "stdlib", version: "1.26.2", ecosystem: "Go" }, groups: [{ ids: ["GO-2026-1"], max_severity: "7.5", experimental_analysis: { "GO-2026-1": { called: false } } }] }] }] };
      expect(normalize("osv", stdlib, ctx())[0]!.severity).toBe("high");
    });
  });

  test("trivy vulnerabilities, misconfigs and secrets", () => {
    const f = normalize("trivy", {
      Results: [
        { Target: "Dockerfile", Misconfigurations: [{ ID: "DS002", Severity: "HIGH", Title: "root user", CauseMetadata: { StartLine: 1 } }] },
        { Target: "app", Vulnerabilities: [{ VulnerabilityID: "CVE-1", PkgName: "openssl", InstalledVersion: "1", Severity: "CRITICAL", Title: "t" }] },
        { Target: "img", Secrets: [{ RuleID: "pk", Severity: "HIGH", Title: "key", StartLine: 1 }] },
      ],
    });
    expect(f.map((x) => x.severity)).toEqual(["high", "critical", "critical"]);
  });

  test("zap risk 3 is high, gosec and hadolint map", () => {
    const zap = normalize("zap", { site: [{ "@name": "https://dev", alerts: [{ pluginid: "10038", alert: "CSP", riskcode: "3", instances: [{ uri: "https://dev/x" }] }] }] });
    expect(zap[0]).toMatchObject({ severity: "high", rule: "zap-10038" });
    const gosec = normalize("gosec", { Issues: [{ rule_id: "G201", severity: "HIGH", file: "/src/a.go", line: "4", details: "sql", code: "4: q" }] });
    expect(gosec[0].severity).toBe("high");
    const hado = normalize("hadolint", [{ code: "DL3002", level: "warning", file: "Dockerfile", line: 3, message: "root" }]);
    expect(hado[0].severity).toBe("medium");
  });

  test("filterNew drops baselined fingerprints; summarize blocks only on new high/critical", () => {
    const all = normalize("semgrep", {
      results: [
        { check_id: "a", path: "x", start: { line: 1 }, extra: { severity: "ERROR", message: "", lines: "1" } },
        { check_id: "b", path: "x", start: { line: 2 }, extra: { severity: "ERROR", message: "", lines: "2" } },
        { check_id: "c", path: "x", start: { line: 3 }, extra: { severity: "INFO", message: "", lines: "3" } },
      ],
    });
    const fresh = filterNew(all, { fingerprints: [all[0].fingerprint] });
    expect(fresh.map((x) => x.rule)).toEqual(["b", "c"]);
    expect(summarize(fresh).block).toBe(true);
    expect(summarize(fresh.filter((x) => x.rule === "c")).block).toBe(false);
  });
  test("a semgrep rule id loses its config-directory prefix, so it is the same in every checkout", () => {
    const at = (check_id: string) => normalize("semgrep", { results: [{ check_id, path: "a.ts", start: { line: 1 }, extra: { severity: "ERROR", message: "m", lines: "l" } }] })[0];
    expect(at("tools.security.rules.custom.neo-js-mass-assignment").rule).toBe("neo-js-mass-assignment");
    expect(at("kit.rules.custom.neo-js-mass-assignment").rule).toBe("neo-js-mass-assignment");
    expect(at("home.neo-wt-security.tools.security.rules.merged.javascript.lang.security.audit.x").rule).toBe("javascript.lang.security.audit.x");
    expect(at("javascript.lang.security.audit.x").rule).toBe("javascript.lang.security.audit.x");
    expect(at("kit.rules.custom.neo-js-mass-assignment").fingerprint).toBe(at("tools.security.rules.custom.neo-js-mass-assignment").fingerprint);
  });

  test("paths are repo-relative: the repo root and the gitleaks /scan mount are stripped", () => {
    const root = "/home/neo-wt-security";
    const sg = normalize("semgrep", { results: [{ check_id: "r", path: `${root}/src/a.ts`, start: { line: 1 }, extra: { severity: "ERROR", message: "", lines: "x" } }] }, { root });
    const rel = normalize("semgrep", { results: [{ check_id: "r", path: "src/a.ts", start: { line: 1 }, extra: { severity: "ERROR", message: "", lines: "x" } }] }, { root });
    expect(sg[0].file).toBe("src/a.ts");
    expect(sg[0].fingerprint).toBe(rel[0].fingerprint);
    const gl = normalize("gitleaks", [{ RuleID: "aws", File: "/scan/config/.env.prod", StartLine: 2, Secret: "s" }], { root });
    expect(gl[0].file).toBe("config/.env.prod");
    const osv = normalize("osv", { results: [{ source: { path: `${root}/bun.lock` }, packages: [] }] }, { root });
    expect(osv).toEqual([]);
    const outside = normalize("gosec", { Issues: [{ rule_id: "G1", severity: "HIGH", file: "/elsewhere/a.go", line: "1", details: "d", code: "" }] }, { root });
    expect(outside[0].file).toBe("/elsewhere/a.go"); // not under the repo: left as is
  });
  test("semgrep without a login says 'requires login' for the code: the fingerprint reads the matched code itself", () => {
    const src = mkdtempSync(join(tmpdir(), "neo-sec-src-"));
    mkdirSync(join(src, "src"));
    writeFileSync(join(src, "src", "a.ts"), "const a = eval(x);\nconst b = eval(y);\n");
    const hit = (offset: number, end: number, line: number) => ({ check_id: "r.eval", path: "src/a.ts", start: { line, offset }, end: { offset: end }, extra: { severity: "ERROR", message: "eval", lines: "requires login" } });
    const f = normalize("semgrep", { results: [hit(10, 17, 1), hit(29, 36, 2)] }, { root: "/repo", src });
    expect(f[0]!.fingerprint).not.toBe(f[1]!.fingerprint);
    // The same code moved down keeps its fingerprint.
    writeFileSync(join(src, "src", "a.ts"), "\n\nconst a = eval(x);\n");
    expect(normalize("semgrep", { results: [hit(12, 19, 3)] }, { root: "/repo", src })[0]!.fingerprint).toBe(f[0]!.fingerprint);
    // An unreadable source still separates findings by position.
    const blind = normalize("semgrep", { results: [hit(10, 17, 1), hit(29, 36, 2)] }, { root: "/repo", src: "/nonexistent" });
    expect(blind[0]!.fingerprint).not.toBe(blind[1]!.fingerprint);
  });
  test("a broken baseline (merge conflict) warns with exit 3 instead of blocking every edit", () => {
    const d = mkdtempSync(join(tmpdir(), "neo-sec-bl-"));
    writeFileSync(join(d, "baseline.json"), "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n");
    writeFileSync(join(d, "sg.json"), JSON.stringify({ results: [] }));
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../tools/security/findings.ts"), "report", "--baseline", join(d, "baseline.json"), `semgrep:${join(d, "sg.json")}`]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr.toString()).toContain("baseline");
  });

  test("missing parts: parsed from tool<TAB>detail lines; a baseline without them warns nothing (ADR-0051)", () => {
    expect(parseMissing("semgrep\tpart 2/5: no output\n\ngitleaks\thistory scan: no report\nodd line\n")).toEqual([
      { tool: "semgrep", detail: "part 2/5: no output" },
      { tool: "gitleaks", detail: "history scan: no report" },
      { tool: "scan", detail: "odd line" },
    ]);
    expect(incompleteWarning(undefined)).toBeUndefined();
    expect(incompleteWarning({ fingerprints: [] })).toBeUndefined();
    expect(incompleteWarning({ fingerprints: [], incomplete: [] })).toBeUndefined();
    const w = incompleteWarning({ fingerprints: [], incomplete: [1, 2, 3, 4, 5].map((n) => ({ tool: "semgrep", detail: `part ${n}/5` })) });
    expect(w).toContain("baseline is incomplete");
    expect(w).toContain("+2 more");
    expect(w).toContain("semgrepTimeoutSec");
    // A malformed list (bad merge) warns; it never throws and so never blocks the layer.
    expect(incompleteWarning({ fingerprints: [], incomplete: "oops" as never })).toContain("unreadable");
  });
});
