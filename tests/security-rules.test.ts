import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUPS, allPacks, buildMerged, commonRules, configsFor, groupOf, mergeRules } from "../tools/security/rules";

const rule = (id: string, languages: string[], extra: Record<string, unknown> = {}) => ({ id, languages, message: "m", severity: "ERROR", pattern: "x", ...extra });

describe("security rule packs", () => {
  test("a file maps to its language group; unknown files have none", () => {
    expect(groupOf("src/a.ts")).toBe("js");
    expect(groupOf("web/App.tsx")).toBe("js");
    expect(groupOf("x.mjs")).toBe("js");
    expect(groupOf("cmd/main.go")).toBe("go");
    expect(groupOf("app.py")).toBe("python");
    expect(groupOf("deploy/Dockerfile")).toBe("dockerfile");
    expect(groupOf("api.dockerfile")).toBe("dockerfile");
    expect(groupOf("docker-compose.prod.yml")).toBe("compose");
    expect(groupOf("compose.yaml")).toBe("compose");
    expect(groupOf("README.md")).toBeUndefined();
  });

  test("merge keeps the group's languages only, drops generic rules, and dedupes ids", () => {
    const packs = [
      { name: "owasp-top-ten", rules: [rule("js.a", ["javascript"]), rule("py.b", ["python"]), rule("generic.secrets.k", ["generic"]), rule("java.c", ["java", "yaml"])] },
      { name: "javascript", rules: [rule("js.a", ["javascript"]), rule("js.d", ["js", "ts"])] },
      { name: "typescript", rules: [rule("js.a", ["javascript"]), rule("ts.e", ["typescript"])] },
    ];
    expect(mergeRules(packs, GROUPS.js!.languages).map((r) => r.id)).toEqual(["js.a", "js.d", "ts.e"]);
  });

  test("the common set is the generic secret rules, once", () => {
    const packs = [
      { name: "secrets", rules: [rule("generic.secrets.k", ["generic"]), rule("generic.nginx.x", ["generic"]), rule("js.a", ["javascript"])] },
      { name: "owasp-top-ten", rules: [rule("generic.secrets.k", ["generic"]), rule("generic.secrets.r", ["regex"])] },
    ];
    expect(commonRules(packs).map((r) => r.id)).toEqual(["generic.secrets.k", "generic.secrets.r"]);
  });

  test("the download list holds every pack once, security-audit included", () => {
    const packs = allPacks();
    expect(new Set(packs).size).toBe(packs.length);
    for (const p of ["owasp-top-ten", "secrets", "security-audit", "javascript", "golang", "dockerfile"]) expect(packs).toContain(p);
  });

  test("build writes one file per group, a deep variant and common; configs name the files a scan needs", () => {
    const kit = mkdtempSync(join(tmpdir(), "neo-sec-rules-"));
    const reg = join(kit, "rules", "registry");
    mkdirSync(reg, { recursive: true });
    mkdirSync(join(kit, "rules", "custom"), { recursive: true });
    const yaml = (rules: unknown[]) => `rules:\n${rules.map((r) => `- ${JSON.stringify(r)}`).join("\n")}\n`;
    writeFileSync(join(reg, "owasp-top-ten.yml"), yaml([rule("js.a", ["javascript"]), rule("go.g", ["go"])]));
    writeFileSync(join(reg, "secrets.yml"), yaml([rule("generic.secrets.k", ["generic"])]));
    writeFileSync(join(reg, "security-audit.yml"), yaml([rule("js.audit", ["javascript"])]));
    writeFileSync(join(reg, "javascript.yml"), "not: [valid"); // a broken download is skipped, not fatal
    const report = buildMerged(kit);
    expect(report.js).toBe(1);
    const merged = (f: string) => JSON.parse(readFileSync(join(kit, "rules", "merged", f), "utf8")).rules.map((r: { id: string }) => r.id);
    expect(merged("js.yml")).toEqual(["js.a"]);
    expect(merged("js-deep.yml")).toEqual(["js.a", "js.audit"]);
    expect(merged("go.yml")).toEqual(["go.g"]);
    expect(merged("common.yml")).toEqual(["generic.secrets.k"]);
    expect(existsSync(join(kit, "rules", "merged", "python.yml"))).toBe(true); // empty groups still get a file

    const base = "/kit/rules";
    expect(configsFor(["src/a.ts", "b.tsx", "README.md"], { kit, base })).toEqual([
      "--config=/kit/rules/merged/common.yml",
      "--config=/kit/rules/merged/js.yml",
      "--config=/kit/rules/custom",
    ]);
    expect(configsFor(["a.go", "b.ts"], { kit, base, deep: true })).toEqual([
      "--config=/kit/rules/merged/common.yml",
      "--config=/kit/rules/merged/go-deep.yml",
      "--config=/kit/rules/merged/js-deep.yml",
      "--config=/kit/rules/custom",
    ]);
  });
});
