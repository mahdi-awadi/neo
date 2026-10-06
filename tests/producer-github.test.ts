// P5 Task 5.2 (spec §7): the GitHub producer — `gh … --json` fixtures through a fake GitRead.
import { test, expect } from "bun:test";
import type { GitRead, GitResult } from "../src/engine/git-read";
import { githubDrafts, GITHUB_KINDS } from "../src/engine/producers/github";

type Fx = Record<string, GitResult>;
const ok = (v: unknown): GitResult => ({ ok: true, out: JSON.stringify(v) });
const fakeGh = (fx: Fx): GitRead & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    git: async () => ({ ok: false, out: "", err: "unused" }),
    gh: async (_f, args) => {
      calls.push(args);
      const key = Object.keys(fx).find((k) => args.join(" ").includes(k));
      return key ? fx[key]! : ok([]);
    },
  };
};
const base: Fx = {
  "repo view": ok({ nameWithOwner: "acme/gold", url: "https://github.com/acme/gold" }),
  "review-requested:@me": ok([{ number: 9, title: "Review me", url: "https://github.com/acme/gold/pull/9" }]),
  "pr list": ok([{ number: 12, title: "Fees", url: "https://github.com/acme/gold/pull/12", isDraft: false }]),
  "run list": ok([
    { databaseId: 3, headBranch: "dev", conclusion: "failure", status: "completed", workflowName: "CI", url: "https://github.com/acme/gold/actions/runs/3" },
    { databaseId: 2, headBranch: "dev", conclusion: "success", status: "completed", workflowName: "CI", url: "u2" },
    { databaseId: 1, headBranch: "main", conclusion: "success", status: "completed", workflowName: "CI", url: "u1" },
    { databaseId: 4, headBranch: "feat/x", conclusion: "failure", status: "completed", workflowName: "CI", url: "u4" },
  ]),
  "--assignee @me": ok([{ number: 31, title: "Bug", url: "https://github.com/acme/gold/issues/31" }]),
  "--label neo": ok([{ number: 31, title: "Bug", url: "https://github.com/acme/gold/issues/31" }, { number: 32, title: "Idea", url: "u32" }]),
  "dependabot/alerts": ok([{ number: 5, html_url: "d5", security_advisory: { severity: "high", summary: "lodash prototype pollution" } }]),
  "code-scanning/alerts": ok([{ number: 7, html_url: "c7", rule: { description: "SQL injection", security_severity_level: "medium" } }]),
  "secret-scanning/alerts": ok([{ number: 2, html_url: "s2", secret_type_display_name: "AWS key" }]),
};
const input = { folder: "/home/gold", project: "gold", cfg: {}, tracked: ["main", "dev"] };

test("each gh read becomes its drafts with the right severities", async () => {
  const r = await githubDrafts(fakeGh(base), input);
  expect(r.failed.size).toBe(0);
  expect(r.drafts.map((d) => [d.kind, d.key, d.severity]).sort()).toEqual([
    ["ci_failed", "dev", "high"],
    ["code_scanning", "7", "normal"],
    ["dependabot", "5", "high"],
    ["issue_open", "31", "normal"],
    ["issue_open", "32", "normal"],
    ["pr_open", "12", "normal"],
    ["pr_review_requested", "9", "normal"],
    ["secret_scanning", "2", "high"],
  ]);
  expect(r.drafts.find((d) => d.kind === "ci_failed")).toMatchObject({ title: "CI failed on dev", url: "https://github.com/acme/gold/actions/runs/3" });
  expect(r.drafts.every((d) => d.source === "github" && d.project === "gold")).toBe(true);
});

test("gh failing for the repo marks every kind failed (nothing resolves); a rate limit says so once", async () => {
  const down = await githubDrafts(fakeGh({ "repo view": { ok: false, out: "", err: "error connecting to api.github.com" } }), input);
  expect([...down.failed].sort()).toEqual([...GITHUB_KINDS].sort());
  expect(down.drafts).toEqual([]);
  const limited = await githubDrafts(fakeGh({ ...base, "pr list": { ok: false, out: "", err: "HTTP 403: API rate limit exceeded for user" } }), input);
  expect(limited.rateLimited).toBe(true);
  expect(limited.failed.has("pr_open")).toBe(true);
});

test("a repo with no GitHub remote has no GitHub items and no error", async () => {
  const r = await githubDrafts(fakeGh({ "repo view": { ok: false, out: "", err: "none of the git remotes configured for this repository point to a known GitHub host" } }), input);
  expect(r).toMatchObject({ drafts: [], github: false });
  expect(r.failed.size).toBe(0);
});

test("an alert feature that is off (404/403) is no items, not a failure; ignoreKinds and issueLabel come from config", async () => {
  const fx = { ...base, "dependabot/alerts": { ok: false, out: "", err: "HTTP 403: Dependabot alerts are disabled for this repository." }, "code-scanning/alerts": { ok: false, out: "", err: "HTTP 404: no analysis found" } };
  const g = fakeGh(fx);
  const r = await githubDrafts(g, { ...input, cfg: { ignoreKinds: ["secret_scanning"], issueLabel: "ops" } });
  expect(r.failed.size).toBe(0);
  expect(r.drafts.map((d) => d.kind)).not.toContain("dependabot");
  expect(r.drafts.map((d) => d.kind)).not.toContain("secret_scanning");
  expect(g.calls.some((c) => c.join(" ").includes("--label ops"))).toBe(true);
});
