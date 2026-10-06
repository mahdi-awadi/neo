/** The GitHub producer (ADR-0018, spec §7): open PRs, PRs waiting for the operator's review, failed CI
 *  on a tracked branch, issues assigned to the operator or labelled for Neo, and security alerts —
 *  read with `gh … --json` through git-read, one project at a time. A read that fails marks its kinds
 *  failed (the scan keeps their rows); an alert feature that is off is simply no items. No repo,
 *  branch or label name is in code (AC5.6). */
import type { AttentionDraft } from "../ledger";
import type { GitRead, GitResult } from "../git-read";
import type { ProjectCfg } from "./git";

export const GITHUB_KINDS = ["pr_open", "pr_review_requested", "ci_failed", "issue_open", "dependabot", "code_scanning", "secret_scanning"] as const;
export type GithubKind = (typeof GITHUB_KINDS)[number];

/** The issue label that marks Neo's issues when a project sets none. */
export const DEFAULT_ISSUE_LABEL = "neo";
/** How many rows one `gh` list asks for. */
const LIST_LIMIT = "50";

export interface GithubScanInput {
  folder: string;
  project: string;
  cfg: ProjectCfg;
  /** The branches that matter (the git scan's tracked branches): CI on them counts, and is high. */
  tracked: string[];
}

export interface GithubScan {
  drafts: AttentionDraft[];
  failed: Set<GithubKind>;
  /** false: the repo has no GitHub remote (nothing to read, nothing failed). */
  github: boolean;
  /** A read hit GitHub's rate limit. */
  rateLimited: boolean;
  /** The first failed read's message, for the scan's meta row and its error event. */
  error?: string;
}

/** Not a GitHub repo at all — no remote, or not a repository GitHub knows. */
const NO_GITHUB = /no git remotes|none of the git remotes|not a git repository|could not resolve to a repository/i;
/** A security-alert feature that is off or not visible to this account. */
const FEATURE_OFF = /HTTP (403|404)/;
const RATE_LIMIT = /rate limit/i;

export async function githubDrafts(read: GitRead, i: GithubScanInput): Promise<GithubScan> {
  const drafts: AttentionDraft[] = [];
  const failed = new Set<GithubKind>();
  let rateLimited = false;
  let error: string | undefined;
  const at = { project: i.project, folder: i.folder, source: "github" as const, severity: "normal" as const };
  const draft = (d: Omit<AttentionDraft, "project" | "folder" | "source" | "severity" | "kind"> & { kind: GithubKind; severity?: AttentionDraft["severity"] }): void =>
    void drafts.push({ ...at, ...d });

  const repo = await read.gh(i.folder, ["repo", "view", "--json", "nameWithOwner,url"]);
  if (!repo.ok) {
    if (NO_GITHUB.test(repo.err ?? "")) return { drafts: [], failed, github: false, rateLimited: false };
    return { drafts: [], failed: new Set(GITHUB_KINDS), github: true, rateLimited: RATE_LIMIT.test(repo.err ?? ""), error: repo.err || "gh failed" };
  }

  /** One JSON read for `kinds`: undefined when it failed (its kinds are marked failed). `optional`:
   *  a 403/404 means the feature is off — an empty list, not a failure. */
  const json = async <T>(kinds: GithubKind[], args: string[], optional = false): Promise<T[] | undefined> => {
    const r: GitResult = await read.gh(i.folder, args);
    if (r.ok) {
      try {
        return JSON.parse(r.out || "[]") as T[];
      } catch {
        error ??= `unreadable JSON from gh ${args.slice(0, 2).join(" ")}`;
        kinds.forEach((k) => failed.add(k));
        return undefined;
      }
    }
    if (RATE_LIMIT.test(r.err ?? "")) rateLimited = true;
    else if (optional && FEATURE_OFF.test(r.err ?? "")) return [];
    error ??= r.err || "gh failed";
    kinds.forEach((k) => failed.add(k));
    return undefined;
  };
  type Item = { number: number; title: string; url: string };

  for (const p of (await json<Item & { isDraft?: boolean }>(["pr_open"], ["pr", "list", "--state", "open", "--limit", LIST_LIMIT, "--json", "number,title,url,isDraft"])) ?? []) {
    draft({ kind: "pr_open", key: String(p.number), title: `PR #${p.number}${p.isDraft ? " (draft)" : ""}: ${p.title}`, url: p.url });
  }
  for (const p of (await json<Item>(["pr_review_requested"], ["pr", "list", "--state", "open", "--search", "review-requested:@me", "--limit", LIST_LIMIT, "--json", "number,title,url"])) ?? []) {
    draft({ kind: "pr_review_requested", key: String(p.number), title: `PR #${p.number} waits for your review: ${p.title}`, url: p.url });
  }

  const runs = await json<{ headBranch: string; conclusion: string; status: string; workflowName: string; url: string }>(
    ["ci_failed"],
    ["run", "list", "--limit", LIST_LIMIT, "--json", "databaseId,headBranch,conclusion,status,workflowName,url"],
  );
  if (runs) {
    // The newest completed run per tracked branch (gh lists newest first).
    const seen = new Set<string>();
    for (const r of runs) {
      if (r.status !== "completed" || !i.tracked.includes(r.headBranch) || seen.has(r.headBranch)) continue;
      seen.add(r.headBranch);
      if (r.conclusion === "failure") draft({ kind: "ci_failed", key: r.headBranch, severity: "high", title: `${r.workflowName} failed on ${r.headBranch}`, url: r.url });
    }
  }

  const label = i.cfg.issueLabel ?? DEFAULT_ISSUE_LABEL;
  const assigned = await json<Item>(["issue_open"], ["issue", "list", "--state", "open", "--assignee", "@me", "--limit", LIST_LIMIT, "--json", "number,title,url"]);
  const labelled = await json<Item>(["issue_open"], ["issue", "list", "--state", "open", "--label", label, "--limit", LIST_LIMIT, "--json", "number,title,url"]);
  if (assigned && labelled) {
    const byNumber = new Map([...assigned, ...labelled].map((x) => [x.number, x]));
    for (const x of byNumber.values()) draft({ kind: "issue_open", key: String(x.number), title: `issue #${x.number}: ${x.title}`, url: x.url });
  }

  const alerts = (path: string) => ["api", `repos/{owner}/{repo}/${path}?state=open&per_page=100`];
  const highSev = (s?: string) => s === "critical" || s === "high";
  for (const a of (await json<{ number: number; html_url: string; security_advisory?: { severity?: string; summary?: string } }>(["dependabot"], alerts("dependabot/alerts"), true)) ?? []) {
    draft({ kind: "dependabot", key: String(a.number), severity: highSev(a.security_advisory?.severity) ? "high" : "normal", title: `dependabot #${a.number} (${a.security_advisory?.severity ?? "?"}): ${a.security_advisory?.summary ?? ""}`, url: a.html_url });
  }
  for (const a of (await json<{ number: number; html_url: string; rule?: { description?: string; security_severity_level?: string } }>(["code_scanning"], alerts("code-scanning/alerts"), true)) ?? []) {
    draft({ kind: "code_scanning", key: String(a.number), severity: highSev(a.rule?.security_severity_level) ? "high" : "normal", title: `code scanning #${a.number}: ${a.rule?.description ?? ""}`, url: a.html_url });
  }
  for (const a of (await json<{ number: number; html_url: string; secret_type_display_name?: string }>(["secret_scanning"], alerts("secret-scanning/alerts"), true)) ?? []) {
    draft({ kind: "secret_scanning", key: String(a.number), severity: "high", title: `secret leaked #${a.number}: ${a.secret_type_display_name ?? "secret"}`, url: a.html_url });
  }

  const ignore = new Set(i.cfg.ignoreKinds ?? []);
  return { drafts: drafts.filter((d) => !ignore.has(d.kind)), failed, github: true, rateLimited, ...(error ? { error } : {}) };
}

/** Config `github` (config.json): how often the scan runs and how long one git/gh call may take. */
export interface GithubCfg {
  scanEveryMs: number;
  callTimeoutMs: number;
}

export const DEFAULT_GITHUB_CFG: GithubCfg = { scanEveryMs: 1_800_000, callTimeoutMs: 20_000 };

export function readGithubCfg(raw: unknown): GithubCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const positive = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 1_000 ? Math.floor(v) : d);
  return { scanEveryMs: positive(r.scanEveryMs, DEFAULT_GITHUB_CFG.scanEveryMs), callTimeoutMs: positive(r.callTimeoutMs, DEFAULT_GITHUB_CFG.callTimeoutMs) };
}
