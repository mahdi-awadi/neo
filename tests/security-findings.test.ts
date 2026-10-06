import { describe, expect, test } from "bun:test";
import { filterNew, normalize, severityFromCvss, summarize } from "../tools/security/findings";

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
});
