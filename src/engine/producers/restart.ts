/** The restart producer (ADR-0018, spec §8.4): what is built but not running, computed from git and
 *  the boot record instead of hand-kept notes. For the Neo repo only: commits after the boot HEAD
 *  (live code differs from running code), local work branches not merged into the running branch,
 *  updater results that need a restart, and a config.json that changed since boot. Plain code, no AI. */
import { basename } from "node:path";
import type { AttentionDraft, BootRow } from "../ledger";
import { branchOf, commitsAfter, git, headOf, unmergedBranches, type GitRunner } from "../git-read";

/** Commits listed in one item's detail. */
const COMMITS_SHOWN = 20;

export const RESTART_KINDS = ["restart_gated"] as const;

/** Config `restart` (config.json): which local branches are work waiting to merge. */
export interface RestartCfg {
  branchPrefixes: string[];
}

export const DEFAULT_RESTART_CFG: RestartCfg = { branchPrefixes: ["fix/", "feat/", "chore/"] };

/** Config `restart`: a non-empty list of non-empty strings is kept, anything else is the default. */
export function readRestartCfg(raw: unknown): RestartCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = r.branchPrefixes;
  return { branchPrefixes: Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === "string" && x.length > 0) ? (p as string[]) : DEFAULT_RESTART_CFG.branchPrefixes };
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
  run?: GitRunner;
}

/** What differs from the running build, as drafts; "error" when git cannot be read (no false resolve). */
export function restartDrafts(d: RestartDeps): AttentionDraft[] | "error" {
  if (!d.boot) return [];
  const run = d.run ?? git;
  const at = { project: basename(d.folder), folder: d.folder, source: "restart" as const, kind: "restart_gated", severity: "normal" as const };
  const branch = branchOf(d.folder, run);
  const commits = commitsAfter(d.folder, d.boot.headSha, COMMITS_SHOWN + 1, run);
  const unmerged = branch ? unmergedBranches(d.folder, branch, run) : undefined;
  if (!branch || !commits || !unmerged) return "error";
  const out: AttentionDraft[] = [];
  if (branch !== d.boot.branch) {
    out.push({ ...at, key: "branch", title: `live checkout is on ${branch}, the daemon runs ${d.boot.branch}` });
  }
  if (commits.length) {
    const more = commits.length > COMMITS_SHOWN ? " (+more)" : "";
    out.push({
      ...at,
      key: "live-code",
      title: `live code differs from running code: ${commits.length > COMMITS_SHOWN ? `${COMMITS_SHOWN}+` : commits.length} commit(s) after the boot (${d.boot.headSha.slice(0, 7)})`,
      detail: commits.slice(0, COMMITS_SHOWN).map((c) => `${c.sha} ${c.subject}`).join("\n") + more,
    });
  }
  for (const u of unmerged) {
    if (u.branch === branch || !d.branchPrefixes.some((p) => u.branch.startsWith(p))) continue;
    out.push({ ...at, key: `merge:${u.branch}`, title: `waiting to merge: ${u.branch} — ${u.subject}` });
  }
  for (const u of d.updates) {
    out.push({ ...at, key: `update:${u.id}`, title: `update needs a restart: ${u.id}${u.from && u.to ? ` ${u.from} → ${u.to}` : ""}` });
  }
  if (d.configHash && d.boot.configHash && d.configHash !== d.boot.configHash) {
    out.push({ ...at, key: "config", title: "config.json changed since boot — keys read at boot apply after a restart" });
  }
  return out;
}

/** `/gated`: the restart-gated list, or that the running build is HEAD. */
export function gatedText(d: RestartDeps): string {
  const drafts = restartDrafts(d);
  if (drafts === "error") return "⚠ could not read git in the Neo repo — /gated unavailable";
  if (!d.boot) return "no boot record yet — /gated works after the next restart";
  if (!drafts.length) return `✓ running build = HEAD (${d.boot.headSha.slice(0, 7)} on ${d.boot.branch}) — nothing waits for a restart`;
  const lines = [`♻️ restart-gated (${drafts.length}) — running ${d.boot.headSha.slice(0, 7)} on ${d.boot.branch}, booted ${new Date(d.boot.at).toISOString().slice(0, 16).replace("T", " ")}`];
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
