import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterNew, incompleteWarning, normalize, parseMissing, severityFromCvss, summarize } from "../tools/security/findings";

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
