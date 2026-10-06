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
  /** Read, but cut at its limit: its drafts count, and its other live rows are kept. */
  partial: Set<GithubKind>;
  /** An alert feature that answered 403/404 (off, or not visible to this account): its rows are kept,
   *  nothing new opens, and it is not a scan failure. */
  unavailable: Set<GithubKind>;
  /** false: the repo has no GitHub remote (nothing to read, nothing failed). */
  github: boolean;
  /** A read hit GitHub's rate limit. */
  rateLimited: boolean;
  /** The first failed read's message, for the scan's meta row and its error event. */
  error?: string;
}

/** Not a GitHub repo at all: no remote, or no remote on GitHub. ("Could not resolve to a Repository"
 *  is a renamed, deleted or inaccessible repo — a failure that keeps the items, not "no GitHub".) */
const NO_GITHUB = /no git remotes|none of the git remotes|not a git repository/i;
/** A security-alert feature that is off or not visible to this account. */
const FEATURE_OFF = /HTTP (403|404)/;
const RATE_LIMIT = /rate limit/i;
/** A completed run that did not pass. */
const CI_FAILED = new Set(["failure", "timed_out", "startup_failure"]);

export async function githubDrafts(read: GitRead, i: GithubScanInput): Promise<GithubScan> {
  const drafts: AttentionDraft[] = [];
  const failed = new Set<GithubKind>();
  const partial = new Set<GithubKind>();
  const unavailable = new Set<GithubKind>();
  let rateLimited = false;
  let error: string | undefined;
  const at = { project: i.project, folder: i.folder, source: "github" as const, severity: "normal" as const };
  const draft = (d: Omit<AttentionDraft, "project" | "folder" | "source" | "severity" | "kind"> & { kind: GithubKind; severity?: AttentionDraft["severity"] }): void =>
    void drafts.push({ ...at, ...d });

  const repo = await read.gh(i.folder, ["repo", "view", "--json", "nameWithOwner,url"]);
  if (!repo.ok) {
    if (NO_GITHUB.test(repo.err ?? "")) return { drafts: [], failed, partial, unavailable, github: false, rateLimited: false };
    return { drafts: [], failed: new Set(GITHUB_KINDS), partial, unavailable, github: true, rateLimited: RATE_LIMIT.test(repo.err ?? ""), error: repo.err || "gh failed" };
  }

  /** One JSON list read for `kinds`: undefined when it failed (its kinds are marked failed). A list
   *  as long as `limit` may be cut: partial. `optional` (an alert feature): 403/404 is unavailable. */
  const json = async <T>(kinds: GithubKind[], args: string[], limit: number, optional = false): Promise<T[] | undefined> => {
    const r: GitResult = await read.gh(i.folder, args);
    if (r.ok) {
      let v: unknown;
      try {
        v = JSON.parse(r.out || "[]");
      } catch {
        v = undefined;
      }
      if (Array.isArray(v)) {
        if (v.length >= limit) kinds.forEach((k) => partial.add(k));
        return v as T[];
      }
      error ??= `unreadable JSON from gh ${args.slice(0, 2).join(" ")}`;
      kinds.forEach((k) => failed.add(k));
      return undefined;
    }
    if (optional && FEATURE_OFF.test(r.err ?? "") && !RATE_LIMIT.test(r.err ?? "")) {
      kinds.forEach((k) => unavailable.add(k));
      return undefined;
    }
    if (RATE_LIMIT.test(r.err ?? "")) rateLimited = true;
    error ??= r.err || "gh failed";
    kinds.forEach((k) => failed.add(k));
    return undefined;
  };
  const LIMIT = Number(LIST_LIMIT);
  type Item = { number: number; title: string; url: string };

  for (const p of (await json<Item & { isDraft?: boolean }>(["pr_open"], ["pr", "list", "--state", "open", "--limit", LIST_LIMIT, "--json", "number,title,url,isDraft"], LIMIT)) ?? []) {
    draft({ kind: "pr_open", key: String(p.number), title: `PR #${p.number}${p.isDraft ? " (draft)" : ""}: ${p.title}`, url: p.url });
  }
  for (const p of (await json<Item>(["pr_review_requested"], ["pr", "list", "--state", "open", "--search", "review-requested:@me", "--limit", LIST_LIMIT, "--json", "number,title,url"], LIMIT)) ?? []) {
    draft({ kind: "pr_review_requested", key: String(p.number), title: `PR #${p.number} waits for your review: ${p.title}`, url: p.url });
  }

  // CI: per tracked branch (a busy repo's other branches never push its runs off the list), the
  // newest completed run of each workflow. No tracked branch known → failed, never "all green".
  if (!i.tracked.length) failed.add("ci_failed");
  for (const branch of i.tracked) {
    const runs = await json<{ headBranch: string; conclusion: string; status: string; workflowName: string; url: string }>(
      ["ci_failed"],
      ["run", "list", "--branch", branch, "--limit", LIST_LIMIT, "--json", "headBranch,conclusion,status,workflowName,url"],
      Number.POSITIVE_INFINITY, // the newest run per workflow is all that matters; older ones never resolve it
    );
    const seen = new Set<string>();
    for (const r of runs ?? []) {
      if (r.status !== "completed" || seen.has(r.workflowName)) continue;
      seen.add(r.workflowName);
      if (CI_FAILED.has(r.conclusion)) draft({ kind: "ci_failed", key: `${branch}:${r.workflowName}`, severity: "high", title: `${r.workflowName} failed on ${branch}`, url: r.url });
    }
  }

  const label = i.cfg.issueLabel ?? DEFAULT_ISSUE_LABEL;
  const assigned = await json<Item>(["issue_open"], ["issue", "list", "--state", "open", "--assignee", "@me", "--limit", LIST_LIMIT, "--json", "number,title,url"], LIMIT);
  const labelled = await json<Item>(["issue_open"], ["issue", "list", "--state", "open", "--label", label, "--limit", LIST_LIMIT, "--json", "number,title,url"], LIMIT);
  if (assigned && labelled) {
    const byNumber = new Map([...assigned, ...labelled].map((x) => [x.number, x]));
    for (const x of byNumber.values()) draft({ kind: "issue_open", key: String(x.number), title: `issue #${x.number}: ${x.title}`, url: x.url });
  }

  const ALERTS_PAGE = 100;
  const alerts = (path: string) => ["api", `repos/{owner}/{repo}/${path}?state=open&per_page=${ALERTS_PAGE}`];
  const highSev = (s?: string) => s === "critical" || s === "high";
  for (const a of (await json<{ number: number; html_url: string; security_advisory?: { severity?: string; summary?: string } }>(["dependabot"], alerts("dependabot/alerts"), ALERTS_PAGE, true)) ?? []) {
    draft({ kind: "dependabot", key: String(a.number), severity: highSev(a.security_advisory?.severity) ? "high" : "normal", title: `dependabot #${a.number} (${a.security_advisory?.severity ?? "?"}): ${a.security_advisory?.summary ?? ""}`, url: a.html_url });
  }
  for (const a of (await json<{ number: number; html_url: string; rule?: { description?: string; security_severity_level?: string } }>(["code_scanning"], alerts("code-scanning/alerts"), ALERTS_PAGE, true)) ?? []) {
    draft({ kind: "code_scanning", key: String(a.number), severity: highSev(a.rule?.security_severity_level) ? "high" : "normal", title: `code scanning #${a.number}: ${a.rule?.description ?? ""}`, url: a.html_url });
  }
  for (const a of (await json<{ number: number; html_url: string; secret_type_display_name?: string }>(["secret_scanning"], alerts("secret-scanning/alerts"), ALERTS_PAGE, true)) ?? []) {
    draft({ kind: "secret_scanning", key: String(a.number), severity: "high", title: `secret leaked #${a.number}: ${a.secret_type_display_name ?? "secret"}`, url: a.html_url });
  }

  const ignore = new Set(i.cfg.ignoreKinds ?? []);
  return { drafts: drafts.filter((d) => !ignore.has(d.kind)), failed, partial, unavailable, github: true, rateLimited, ...(error ? { error: rateLimited ? `GitHub rate limit: ${error}` : error } : {}) };
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
