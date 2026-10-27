/** The restart producer (ADR-0018, spec §8.4): what is built but not running, computed from git and
 *  the boot record instead of hand-kept notes. For the Neo repo only: commits after the boot HEAD
 *  (live code differs from running code), local work branches not merged into the running branch,
 *  updater results that need a restart, and a config.json that changed since boot. Plain code, no AI. */
import { basename } from "node:path";
import type { AttentionDraft, BootRow } from "../ledger";
import { branchOf, branchTip, commitsAfter, git, hasCommit, headOf, isAncestor, unmergedBranches, type GitRunner } from "../git-read";

/** Commits listed in one item's detail. */
const COMMITS_SHOWN = 20;

export const RESTART_KINDS = ["restart_gated"] as const;

/** Config `restart` (config.json): which local branches are work waiting to merge, and the branch
 *  where finished work collects before it runs (ADR-0054). */
export interface RestartCfg {
  branchPrefixes: string[];
  /** The integration branch: its commits that are not in the running build are one item. */
  integrationBranch: string;
  /** The item turns `high` once its oldest unrun commit is older than this many days. */
  maxUndeployedDays: number;
}

export const DEFAULT_RESTART_CFG: RestartCfg = { branchPrefixes: ["fix/", "feat/", "chore/"], integrationBranch: "dev", maxUndeployedDays: 2 };

/** Config `restart`: a bad or missing field keeps its default. */
export function readRestartCfg(raw: unknown): RestartCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = r.branchPrefixes;
  const b = r.integrationBranch;
  const days = r.maxUndeployedDays;
  return {
    branchPrefixes: Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === "string" && x.length > 0) ? (p as string[]) : DEFAULT_RESTART_CFG.branchPrefixes,
    integrationBranch: typeof b === "string" && /^[\w./-]+$/.test(b) && !b.startsWith("-") ? b : DEFAULT_RESTART_CFG.integrationBranch,
    maxUndeployedDays: typeof days === "number" && Number.isInteger(days) && days >= 0 ? days : DEFAULT_RESTART_CFG.maxUndeployedDays,
  };
}

export interface RestartDeps {
  /** The Neo repo (the daemon's working folder). */
  folder: string;
  /** This daemon's boot record; none → nothing to compare against. */
  boot: BootRow | undefined;
  /** Branch-name prefixes that are work waiting to merge (config `restart.branchPrefixes`). */
  branchPrefixes: string[];
  /** Updater results since boot that need a restart (id + what changed). */
  updates: Array<{ id: string; from?: string; to?: string }>;
  /** config.json's hash now; compared with the boot's. */
  configHash?: string;
  /** The integration branch (config `restart.integrationBranch`, ADR-0054); none → not checked. */
  integrationBranch?: string;
  /** Days before the integration item turns `high` (config `restart.maxUndeployedDays`). */
  maxUndeployedDays?: number;
  now?: number;
  run?: GitRunner;
}

/** What differs from the running build, as drafts; "error" when git cannot be read or there is no
 *  boot record to compare with — a failed read never resolves anything (spec §7). */
export function restartDrafts(d: RestartDeps): AttentionDraft[] | "error" {
  if (!d.boot) return "error";
  const boot = d.boot;
  const run = d.run ?? git;
  const at = { project: basename(d.folder), folder: d.folder, source: "restart" as const, kind: RESTART_KINDS[0], severity: "normal" as const };
  const head = headOf(d.folder, run);
  const branch = branchOf(d.folder, run);
  if (!head || !branch) return "error";
  const out: AttentionDraft[] = [];
  const short = (sha: string) => sha.slice(0, 7);
  if (!hasCommit(d.folder, boot.headSha, run)) {
    // History was rewritten (or this is a fresh clone): the running build is not in the repo at all.
    out.push({ ...at, key: "live-code", title: `running build ${short(boot.headSha)} is no longer in the repo (history rewritten) — live HEAD is ${short(head)}` });
  } else if (head !== boot.headSha) {
    const commits = commitsAfter(d.folder, boot.headSha, COMMITS_SHOWN + 1, run);
    if (!commits) return "error";
    const listed = commits.slice(0, COMMITS_SHOWN).map((c) => `${c.sha} ${c.subject}`).join("\n") + (commits.length > COMMITS_SHOWN ? "\n(+more)" : "");
    const n = commits.length > COMMITS_SHOWN ? `${COMMITS_SHOWN}+` : String(commits.length);
    out.push({
      ...at,
      key: "live-code",
      // A reset, rebase or amend: HEAD no longer contains what runs, so "N commits after" would lie.
      title: isAncestor(d.folder, boot.headSha, head, run)
        ? `live code differs from running code: ${n} commit(s) after the boot (${short(boot.headSha)})`
        : `live code differs from running code: HEAD ${short(head)} does not contain the running build ${short(boot.headSha)} (reset, rebase or amend)`,
      ...(listed ? { detail: listed } : {}),
    });
  }
  // What runs: its branch, or its commit when the daemon booted on a detached HEAD.
  const running = boot.branch === "HEAD" ? short(boot.headSha) : boot.branch;
  if (branch === "HEAD") {
    if (boot.branch !== "HEAD" || head !== boot.headSha) out.push({ ...at, key: "branch", title: `live checkout is detached at ${short(head)}, the daemon runs ${running}` });
  } else if (branch !== boot.branch) out.push({ ...at, key: "branch", title: `live checkout is on ${branch}, the daemon runs ${running}` });
  // Work waiting to merge into what runs: the running branch, or the running commit if that branch is gone.
  const into = boot.branch === "HEAD" ? boot.headSha : boot.branch;
  const unmerged = unmergedBranches(d.folder, into, run) ?? unmergedBranches(d.folder, boot.headSha, run);
  if (!unmerged) return "error";
  // Finished work on the integration branch that does not run (ADR-0054): one item, never silent.
  const gap = integrationGap(d);
  if (gap === "error") return "error";
  if (gap) {
    const n = gap.commits;
    out.push({
      ...at,
      key: "integration",
      severity: gap.high ? "high" : "normal",
      title: `${n} commit${n === 1 ? ` on ${gap.integration} is` : `s on ${gap.integration} are`} not running (oldest ${gap.days} day${gap.days === 1 ? "" : "s"})`,
      detail: [...(gap.adrs.length ? [`ADRs: ${gap.adrs.join(", ")}`] : []), ...gap.lines].join("\n"),
    });
  }
  const integTip = d.integrationBranch && d.integrationBranch !== boot.branch ? branchTip(d.folder, d.integrationBranch, run) : undefined;
  for (const u of unmerged) {
    if (u.branch === branch || u.branch === boot.branch || !d.branchPrefixes.some((p) => u.branch.startsWith(p))) continue;
    // Already merged into the integration branch: that item covers it (ADR-0054), no second line.
    if (integTip && isAncestor(d.folder, u.branch, integTip, run)) continue;
    out.push({ ...at, key: `merge:${u.branch}`, title: `waiting to merge: ${u.branch} — ${u.subject}` });
  }
  for (const u of d.updates) {
    out.push({ ...at, key: `update:${u.id}`, title: `update needs a restart: ${u.id}${u.from && u.to ? ` ${u.from} → ${u.to}` : ""}` });
  }
  if (d.configHash && boot.configHash && d.configHash !== boot.configHash) {
    out.push({ ...at, key: "config", title: "config.json changed since boot — keys read at boot apply after a restart" });
  }
  return out;
}

/** Finished work that does not run (ADR-0054): the integration branch's commits that are not in the
 *  running build. The ONE computation behind the restart item, `/list` and the console header. */
export interface IntegrationGap {
  /** The running build's short sha and branch. */
  running: string;
  branch: string;
  integration: string;
  commits: number;
  /** Age of the oldest unrun commit, whole days. */
  days: number;
  /** Older than `maxUndeployedDays`. */
  high: boolean;
  /** The ADR numbers the unrun commits name. */
  adrs: string[];
}

/** The gap, undefined when there is none (no boot, no such branch, running on it, nothing unrun), or
 *  "error" when git cannot be read. `lines` (the commits shown) is for the restart item's detail. */
export function integrationGap(d: RestartDeps): (IntegrationGap & { lines: string[] }) | undefined | "error" {
  const integ = d.integrationBranch;
  if (!d.boot || !integ || integ === d.boot.branch) return undefined;
  const run = d.run ?? git;
  const tip = branchTip(d.folder, integ, run);
  if (!tip) return undefined;
  const commits = commitsAfter(d.folder, d.boot.headSha, COMMITS_SHOWN * 50, run, tip);
  if (!commits) return "error";
  if (!commits.length) return undefined;
  const now = d.now ?? Date.now();
  const oldestAt = Math.min(...commits.map((c) => c.at ?? now));
  const days = Math.max(0, Math.floor((now - oldestAt) / 86_400_000));
  return {
    running: d.boot.headSha.slice(0, 7),
    branch: d.boot.branch,
    integration: integ,
    commits: commits.length,
    days,
    high: days > (d.maxUndeployedDays ?? DEFAULT_RESTART_CFG.maxUndeployedDays),
    adrs: [...new Set(commits.flatMap((c) => c.subject.match(/ADR-\d{4}/g) ?? []))].sort(),
    lines: [...commits.slice(0, COMMITS_SHOWN).map((c) => `${c.sha} ${c.subject}`), ...(commits.length > COMMITS_SHOWN ? ["(+more)"] : [])],
  };
}

/** The one-line deploy gap for `/list` (ADR-0054), or undefined when everything finished runs. */
export function gapLine(g: IntegrationGap | undefined): string | undefined {
  return g ? `${g.high ? "⚠" : "•"} running ${g.running} on ${g.branch} · ${g.integration} +${g.commits} not running (oldest ${g.days} day${g.days === 1 ? "" : "s"})` : undefined;
}

/** `/gated`: the restart-gated list, or that the running build is HEAD. */
export function gatedText(d: RestartDeps): string {
  if (!d.boot) return "no boot record yet — /gated works after the next restart";
  const drafts = restartDrafts(d);
  if (drafts === "error") return "⚠ could not read git in the Neo repo — /gated unavailable";
  if (!drafts.length) return `✓ running build = HEAD (${d.boot.headSha.slice(0, 7)} on ${d.boot.branch}) — nothing waits for a restart`;
  const lines = [`♻️ restart-gated (${drafts.length}) — running ${d.boot.headSha.slice(0, 7)} on ${d.boot.branch}, booted ${new Date(d.boot.at).toISOString().slice(0, 16).replace("T", " ")} UTC`];
  for (const x of drafts) {
    lines.push(`• ${x.title}`);
    if (x.key === "live-code" && x.detail) lines.push(...x.detail.split("\n").map((l) => `    ${l}`));
  }
  return lines.join("\n");
}

/** The boot record's git facts for `folder` (HEAD + branch), read at daemon start. */
export function bootFacts(folder: string, run: GitRunner = git): { headSha: string; branch: string } | undefined {
  const headSha = headOf(folder, run);
  const branch = branchOf(folder, run);
  return headSha && branch ? { headSha, branch } : undefined;
}
