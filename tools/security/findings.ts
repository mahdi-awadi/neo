// Normalises scanner output (semgrep, gitleaks, osv-scanner, trivy, gosec, hadolint, ZAP) into one
// finding shape, filters it against a project's baseline, and decides whether to block.
//
// Policy: only NEW high/critical findings block. Baselined findings are tracked, not blocking.
// Fingerprints ignore line numbers so a finding does not turn "new" when code above it moves.
// Secrets are never copied into a finding — only a hash of them.
//
//   bun tools/security/findings.ts report   [--baseline f] [--out f] [--label s] [--root repo] tool:raw.json ...
//   bun tools/security/findings.ts baseline --baseline f [--root repo] tool:raw.json ...
//   (exit 1 from `report` = new high/critical findings; exit 3 = the baseline is unreadable, warn only)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type Severity = "critical" | "high" | "medium" | "low";
export type Tool = "semgrep" | "gitleaks" | "osv" | "trivy" | "gosec" | "hadolint" | "zap";

export interface Finding {
  tool: Tool;
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  message: string;
  fingerprint: string;
  /** `unreachable`: osv's Go call analysis found the vulnerable code never called (ADR-0066). */
  tags?: string[];
}

/** A piece of a scan that produced no result (ADR-0051): a semgrep part that timed out, a gitleaks
 *  scan with no output. */
export interface MissingPart {
  tool: string;
  detail: string;
}

export interface Baseline {
  fingerprints: string[];
  /** Missing parts of the scan that recorded it; absent in a baseline older than ADR-0051. */
  incomplete?: MissingPart[];
}

/** `scan.sh`'s missing-part file: one `tool<TAB>detail` line per part. */
export function parseMissing(text: string): MissingPart[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const i = l.indexOf("\t");
      return i < 0 ? { tool: "scan", detail: l.trim() } : { tool: l.slice(0, i), detail: l.slice(i + 1).trim() };
    });
}

/** The warning for a layer that compares against an incomplete baseline, or undefined. */
export function incompleteWarning(baseline: Baseline | undefined): string | undefined {
  const raw: unknown = baseline?.incomplete;
  if (raw === undefined) return undefined;
  // A hand-edited or merged baseline may hold anything here: an unreadable list is still a warning.
  const parts: MissingPart[] = Array.isArray(raw) ? raw.map((p) => ({ tool: String(p?.tool ?? "scan"), detail: String(p?.detail ?? p) })) : [{ tool: "baseline", detail: "unreadable incomplete list" }];
  if (!parts.length) return undefined;
  const list = parts.slice(0, 3).map((p) => `${p.tool}: ${p.detail}`).join("; ");
  return (
    `[security] warn: the baseline is incomplete (${list}${parts.length > 3 ? `; +${parts.length - 3} more` : ""}) — ` +
    "findings it missed may show as new. Re-record it: scan.sh baseline <repo> (raise semgrepTimeoutSec or lower " +
    "semgrepChunkFiles in .security/config.json)"
  );
}

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

const hash = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
const squash = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

function make(tool: Tool, rule: string, severity: Severity, file: string, line: number, message: string, key: string): Finding {
  return { tool, rule, severity, file, line, message: squash(message).slice(0, 300), fingerprint: hash(tool, rule, file, key) };
}

/** CVSS base score → severity. An unknown score fails closed to high. */
export function severityFromCvss(score: string | number | undefined): Severity {
  const n = Number.parseFloat(String(score ?? ""));
  if (Number.isNaN(n)) return "high";
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "medium";
  return "low";
}

function word(s: unknown): Severity {
  const v = String(s ?? "").toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high" || v === "error") return "high";
  if (v === "medium" || v === "warning" || v === "moderate") return "medium";
  return "low";
}

// biome-ignore lint: scanner JSON is untyped by nature
type Any = any;

/** The most an unreachable vulnerability can weigh: below the blocking level, still in every report. */
const UNREACHABLE_CAP: Severity = "medium";

/** osv's Go call analysis (govulncheck, ADR-0066): true only when osv analysed this group and found
 *  every one of its vulnerabilities uncalled. Fails closed: another ecosystem, no analysis (no Go
 *  toolchain, or govulncheck failed), an id without a verdict or a verdict that is not `false`. */
export function osvUnreachable(ecosystem: unknown, group: Any): boolean {
  const verdicts = group?.experimentalAnalysis;
  const ids: unknown[] = Array.isArray(group?.ids) ? group.ids : [];
  if (ecosystem !== "Go" || !verdicts || typeof verdicts !== "object" || !ids.length) return false;
  return ids.every((id) => verdicts[String(id)]?.called === false);
}

/** Semgrep prefixes a rule id with its config file's directory, relative to where it ran
 *  (`tools.security.rules.custom.neo-js-x`). The id without it is the same in every checkout. */
export function ruleId(id: string): string {
  return String(id ?? "").replace(/^(?:[\w-]+\.)*?rules\.(?:custom|merged|registry)\./, "");
}

/** A scanner path, repo-relative: the repo root and the gitleaks `/scan` mount are stripped. A path
 *  outside the repo stays as it is. */
export function relPath(path: string, root?: string): string {
  const p = String(path ?? "");
  if (p.startsWith("/scan/")) return p.slice("/scan/".length);
  if (root && p.startsWith(`${root.replace(/\/+$/, "")}/`)) return p.slice(root.replace(/\/+$/, "").length + 1);
  return p;
}

/** Semgrep without a login reports `"requires login"` for the matched code, so the code is read from
 *  the scanned source by its byte offsets. Unreadable: the reported lines, else the position. */
function matchedCode(r: Any, base: string | undefined, cache: Map<string, Buffer | null>): string {
  const lines = String(r.extra?.lines ?? "");
  const file = String(r.path ?? "");
  if (base && file && Number.isInteger(r.start?.offset) && Number.isInteger(r.end?.offset)) {
    const path = isAbsolute(file) ? file : join(base, file);
    if (!cache.has(path)) cache.set(path, existsSync(path) ? readFileSync(path) : null);
    const buf = cache.get(path);
    if (buf) return squash(buf.subarray(r.start.offset, r.end.offset).toString("utf8"));
  }
  return lines && lines !== "requires login" ? squash(lines) : `@${r.start?.line ?? 0}:${r.start?.col ?? 0}`;
}

export function normalize(tool: Tool, raw: Any, ctx: { root?: string; src?: string } = {}): Finding[] {
  const sources = new Map<string, Buffer | null>();
  // Every finding is built here, so its file and rule are canonical before the fingerprint is taken.
  const mk = (t: Tool, rule: string, severity: Severity, file: string, line: number, message: string, key: string) =>
    make(t, ruleId(rule), severity, relPath(file, ctx.root), line, message, key);
  switch (tool) {
    case "semgrep":
      return (raw?.results ?? []).map((r: Any) => {
        let sev = word(r.extra?.severity);
        const m = r.extra?.metadata ?? {};
        if (sev === "medium" && String(m.impact).toUpperCase() === "HIGH" && String(m.confidence).toUpperCase() !== "LOW") sev = "high";
        return mk("semgrep", r.check_id, sev, r.path, r.start?.line ?? 0, r.extra?.message, matchedCode(r, ctx.src ?? ctx.root, sources));
      });
    case "gitleaks":
      return (Array.isArray(raw) ? raw : []).map((r: Any) =>
        mk("gitleaks", r.RuleID, "critical", r.File, r.StartLine ?? 0, `secret (${r.RuleID})${r.Commit ? ` in commit ${String(r.Commit).slice(0, 8)}` : ""}`, hash(String(r.Secret ?? r.Match ?? ""))),
      );
    case "osv":
      return (raw?.results ?? []).flatMap((res: Any) =>
        (res.packages ?? []).flatMap((p: Any) =>
          (p.groups ?? []).map((g: Any) => {
            const id = (g.ids ?? [])[0] ?? "osv";
            const pkg = `${p.package?.name}@${p.package?.version}`;
            const message = `${pkg} (${p.package?.ecosystem}) ${(g.aliases ?? g.ids ?? []).join(" ")}`;
            const full = severityFromCvss(g.max_severity);
            if (!osvUnreachable(p.package?.ecosystem, g)) return mk("osv", id, full, res.source?.path ?? "", 0, message, pkg);
            const capped = RANK[full] > RANK[UNREACHABLE_CAP] ? UNREACHABLE_CAP : full;
            const f = mk("osv", id, capped, res.source?.path ?? "", 0, `unreachable (never called): ${message}`, pkg);
            return { ...f, tags: ["unreachable"] };
          }),
        ),
      );
    case "trivy":
      return (raw?.Results ?? []).flatMap((r: Any) => [
        ...(r.Vulnerabilities ?? []).map((v: Any) => mk("trivy", v.VulnerabilityID, word(v.Severity), r.Target, 0, `${v.PkgName}@${v.InstalledVersion}: ${v.Title ?? ""}`, `${v.PkgName}@${v.InstalledVersion}`)),
        ...(r.Misconfigurations ?? []).map((v: Any) => mk("trivy", v.ID, word(v.Severity), r.Target, v.CauseMetadata?.StartLine ?? 0, v.Title ?? v.Message, squash(v.Message ?? v.Title))),
        ...(r.Secrets ?? []).map((v: Any) => mk("trivy", v.RuleID, "critical", r.Target, v.StartLine ?? 0, `secret: ${v.Title ?? v.RuleID}`, `${v.RuleID}:${v.StartLine}`)),
      ]);
    case "gosec":
      return (raw?.Issues ?? []).map((r: Any) => mk("gosec", r.rule_id, word(r.severity), r.file, Number(r.line) || 0, r.details, squash(String(r.code ?? "").replace(/^\d+:\s*/gm, ""))));
    case "hadolint":
      return (Array.isArray(raw) ? raw : []).map((r: Any) => mk("hadolint", r.code, r.level === "error" ? "high" : r.level === "warning" ? "medium" : "low", r.file, r.line ?? 0, r.message, squash(r.message)));
    case "zap":
      return (raw?.site ?? []).flatMap((s: Any) =>
        (s.alerts ?? []).map((a: Any) => {
          const sev: Severity = a.riskcode === "3" ? "high" : a.riskcode === "2" ? "medium" : "low";
          return mk("zap", `zap-${a.pluginid}`, sev, s["@name"], 0, `${a.alert} (${a.instances?.[0]?.uri ?? ""})`, a.alert);
        }),
      );
  }
}

export function filterNew(findings: Finding[], baseline: Baseline | undefined): Finding[] {
  const known = new Set(baseline?.fingerprints ?? []);
  return findings.filter((f) => !known.has(f.fingerprint));
}

export function summarize(findings: Finding[]): { block: boolean; counts: Record<Severity, number> } {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return { block: counts.critical + counts.high > 0, counts };
}

function load(spec: string, ctx: { root?: string; src?: string }): Finding[] {
  const i = spec.indexOf(":");
  const tool = spec.slice(0, i) as Tool;
  const path = spec.slice(i + 1);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  try {
    return normalize(tool, JSON.parse(text), ctx);
  } catch {
    console.error(`[security] could not parse ${tool} output ${path}`);
    return [];
  }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  let baselinePath: string | undefined;
  let outPath: string | undefined;
  let label = "scan";
  let root: string | undefined;
  let src: string | undefined;
  let missingPath: string | undefined;
  const specs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--baseline") baselinePath = rest[++i];
    else if (rest[i] === "--out") outPath = rest[++i];
    else if (rest[i] === "--label") label = rest[++i];
    else if (rest[i] === "--root") root = rest[++i];
    else if (rest[i] === "--src") src = rest[++i]; // where the scanned files are (staged: the index copy)
    else if (rest[i] === "--missing") missingPath = rest[++i]; // scan.sh's missing parts (ADR-0051)
    else specs.push(rest[i]);
  }
  const all = specs.flatMap((spec) => load(spec, { root, src }));
  const incomplete = missingPath && existsSync(missingPath) ? parseMissing(readFileSync(missingPath, "utf8")) : [];
  if (cmd === "baseline") {
    if (!baselinePath) throw new Error("--baseline required");
    const fingerprints = [...new Set(all.map((f) => f.fingerprint))].sort();
    const created = new Date().toISOString();
    writeFileSync(baselinePath, `${JSON.stringify({ created, fingerprints, incomplete, findings: all }, null, 2)}\n`);
    console.log(`[security] baseline written: ${fingerprints.length} findings tracked → ${baselinePath}`);
    for (const p of incomplete) console.error(`[security] warn: the baseline is INCOMPLETE — ${p.tool}: ${p.detail}`);
    process.exit(0);
  }
  let baseline: Baseline | undefined;
  if (baselinePath && existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
    } catch {
      // A broken baseline (e.g. merge-conflict markers) must not read as "new findings": that would
      // block every edit. Exit 3 = scan unusable, warn only.
      console.error(`[security] warn: ${baselinePath} is not valid JSON (merge conflict?) — fix it; scan skipped`);
      process.exit(3);
    }
  }
  const fresh = filterNew(all, baseline).sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const { block, counts } = summarize(fresh);
  if (outPath) writeFileSync(outPath, `${JSON.stringify({ label, at: new Date().toISOString(), counts, incomplete, findings: fresh }, null, 2)}\n`);
  const warn = incompleteWarning(baseline);
  if (warn) console.error(warn);
  const known = all.length - fresh.length;
  console.log(`[security] ${label}: new ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low (${known} baselined)`);
  for (const f of fresh.filter((x) => RANK[x.severity] >= 2).slice(0, 40)) {
    console.log(`  ${f.severity.toUpperCase().padEnd(8)} ${f.file}${f.line ? `:${f.line}` : ""}  [${f.tool}:${f.rule}] ${f.message}`);
  }
  process.exit(block ? 1 : 0);
}
