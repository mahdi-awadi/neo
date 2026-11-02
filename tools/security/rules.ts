// Semgrep rule packs: which packs exist, which language group a file belongs to, and the merged rule
// files a scan loads (ADR-0024). The registry packs overlap a lot (the same rule in several packs,
// rules for other languages), and loading all of them made one write-time scan take 36 s. So
// update-rules.sh downloads the packs once, and `build` writes per-group files with only that
// group's rules, each id once. `generic.secrets` rules go in one `common` file for every group.
//
//   bun tools/security/rules.ts packs                      the pack names to download
//   bun tools/security/rules.ts build [kit]                write rules/merged/*.yml
//   bun tools/security/rules.ts configs [--deep] --base <dir> <file>...   semgrep --config flags
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Rule {
  id: string;
  languages?: string[];
  [k: string]: unknown;
}
export interface Pack {
  name: string;
  rules: Rule[];
}

/** Packs every group loads: the OWASP core and the cross-language classes. */
const CORE = ["owasp-top-ten", "secrets", "jwt", "xss", "sql-injection", "command-injection", "insecure-transport"];
/** Added for the deep layers (push, nightly): broad, noisier audit rules. */
const DEEP = ["security-audit"];

export const GROUPS: Record<string, { file: RegExp; languages: string[]; packs: string[] }> = {
  js: { file: /\.(ts|tsx|js|jsx|mjs|cjs)$/, languages: ["javascript", "js", "typescript", "ts"], packs: ["javascript", "typescript", "react", "nodejs", "nodejsscan"] },
  go: { file: /\.go$/, languages: ["go", "golang"], packs: ["golang", "gosec"] },
  python: { file: /\.py$/, languages: ["python", "py", "python3"], packs: ["python", "bandit", "flask", "django"] },
  php: { file: /\.php$/, languages: ["php"], packs: ["php"] },
  java: { file: /\.java$/, languages: ["java"], packs: ["java"] },
  csharp: { file: /\.cs$/, languages: ["csharp", "c#"], packs: ["csharp"] },
  terraform: { file: /\.tf$/, languages: ["terraform", "hcl"], packs: ["terraform"] },
  dockerfile: { file: /(^|\/)(Dockerfile[^/]*|[^/]*\.dockerfile)$/, languages: ["dockerfile", "docker"], packs: ["dockerfile"] },
  compose: { file: /(^|\/)[^/]*compose[^/]*\.ya?ml$/, languages: ["yaml"], packs: ["docker-compose", "kubernetes"] },
};

/** The language group a file is scanned as, or undefined (no semgrep packs for it). */
export function groupOf(file: string): string | undefined {
  return Object.keys(GROUPS).find((g) => GROUPS[g]!.file.test(file));
}

/** Every pack update-rules.sh downloads, each once. */
export function allPacks(): string[] {
  return [...new Set([...CORE, ...DEEP, ...Object.values(GROUPS).flatMap((g) => g.packs)])];
}

const isGeneric = (r: Rule) => (r.languages ?? []).some((l) => l === "generic" || l === "regex");

function dedupe(rules: Rule[]): Rule[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

/** The rules of `packs` for one group's languages, each id once, in pack order. */
export function mergeRules(packs: Pack[], languages: string[]): Rule[] {
  const want = new Set(languages);
  return dedupe(packs.flatMap((p) => p.rules).filter((r) => !isGeneric(r) && (r.languages ?? []).some((l) => want.has(l))));
}

/** The generic secret rules, once: they apply to any file, so they load once per scan. */
export function commonRules(packs: Pack[]): Rule[] {
  return dedupe(packs.flatMap((p) => p.rules).filter((r) => isGeneric(r) && r.id.startsWith("generic.secrets.")));
}

function readPack(dir: string, name: string): Pack | undefined {
  const path = join(dir, `${name}.yml`);
  if (!existsSync(path)) return undefined;
  try {
    const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as { rules?: Rule[] } | null;
    return Array.isArray(doc?.rules) ? { name, rules: doc.rules } : undefined;
  } catch {
    console.error(`[security] warn: could not parse rule pack ${name} (skipped)`);
    return undefined;
  }
}

/** Write rules/merged/<group>.yml, <group>-deep.yml and common.yml under `kit`. Returns the rule count
 *  per group. JSON is valid YAML, and semgrep reads it faster. */
export function buildMerged(kit: string): Record<string, number> {
  const reg = join(kit, "rules", "registry");
  const out = join(kit, "rules", "merged");
  mkdirSync(out, { recursive: true });
  const load = (names: string[]) => names.flatMap((n) => readPack(reg, n) ?? []);
  const write = (name: string, rules: Rule[]) => writeFileSync(join(out, `${name}.yml`), JSON.stringify({ rules }));
  const counts: Record<string, number> = {};
  for (const [g, def] of Object.entries(GROUPS)) {
    const rules = mergeRules(load([...CORE, ...def.packs]), def.languages);
    write(g, rules);
    write(`${g}-deep`, mergeRules(load([...CORE, ...def.packs, ...DEEP]), def.languages));
    counts[g] = rules.length;
  }
  const common = commonRules(load(allPacks()));
  write("common", common);
  counts.common = common.length;
  return counts;
}

/** The semgrep --config flags for scanning `files`: common, each group present, then the custom
 *  rules. `base` is where the kit's rules/ directory is seen by semgrep (inside the container). */
export function configsFor(files: string[], opts: { kit: string; base: string; deep?: boolean }): string[] {
  const groups = [...new Set(files.flatMap((f) => groupOf(f) ?? []))].sort();
  const merged = join(opts.kit, "rules", "merged");
  const names = ["common", ...groups.map((g) => (opts.deep ? `${g}-deep` : g))];
  const out: string[] = [];
  for (const n of names) {
    if (existsSync(join(merged, `${n}.yml`))) out.push(`--config=${opts.base}/merged/${n}.yml`);
    else console.error(`[security] warn: rules/merged/${n}.yml missing — run tools/security/update-rules.sh`);
  }
  out.push(`--config=${opts.base}/custom`);
  return out;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const here = import.meta.dir;
  if (cmd === "packs") console.log(allPacks().join("\n"));
  else if (cmd === "build") {
    const counts = buildMerged(rest[0] ?? here);
    console.log(`[security] merged rules: ${Object.entries(counts).map(([g, n]) => `${g} ${n}`).join(", ")}`);
  } else if (cmd === "configs") {
    let deep = false;
    let base = join(here, "rules");
    const files: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--deep") deep = true;
      else if (rest[i] === "--base") base = rest[++i]!;
      else files.push(rest[i]!);
    }
    console.log(configsFor(files, { kit: here, base, deep }).join("\n"));
  } else {
    console.error("usage: rules.ts packs | build [kit] | configs [--deep] [--base dir] <file>...");
    process.exit(2);
  }
}
