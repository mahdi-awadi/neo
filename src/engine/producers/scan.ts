/** The repo scan (ADR-0018, spec §7): every tracked repo, one at a time — the git producer and the
 *  GitHub producer, each reconciled for that project (a kind whose read failed keeps its rows), and a
 *  `meta` row per project (`gh:<project>`: last scan, last good scan, counts, error) for the
 *  dashboard. A heartbeat step starts it every `github.scanEveryMs`. Plain code, no AI. */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Ledger } from "../ledger";
import type { Registry } from "../registry";
import type { GitRead } from "../git-read";
import { reconcileScan } from "../attention";
import type { AttentionCfg } from "./engine";
import { gitDrafts, type ProjectCfg } from "./git";
import { githubDrafts } from "./github";

const HOUR = 3_600_000;

export interface ScanDeps {
  ledger: Ledger;
  registry: Registry;
  read: GitRead;
  /** Repos under this root are tracked (plus Neo itself). */
  workRoot: string;
  neoFolder: string;
  attention: AttentionCfg;
  projects: Record<string, ProjectCfg>;
  now: () => number;
}

/** What `gh:<project>` holds. */
export interface ScanMeta {
  lastScanAt: number;
  /** The last scan in which every read worked. */
  lastGoodAt?: number;
  github: boolean;
  counts: Record<string, number>;
  error?: string;
  /** The last github_scan_error event (one per project per hour). */
  errorEventAt?: number;
}

/** The repos to scan: each folder the ledger has worked in that is a repo's top folder under
 *  `workRoot` (not a sub-folder, not a linked worktree — those show as `worktree` items of their
 *  repo), plus Neo itself. Sorted, so a scan's order is stable. */
export async function trackedRepos(d: Pick<ScanDeps, "ledger" | "read" | "workRoot" | "neoFolder">): Promise<string[]> {
  const root = resolve(d.workRoot);
  const candidates = new Set([...d.ledger.folders(), d.neoFolder].map((f) => resolve(f)));
  const out: string[] = [];
  for (const f of [...candidates].sort()) {
    if ((f !== resolve(d.neoFolder) && !f.startsWith(`${root}/`)) || !existsSync(f)) continue;
    const r = await d.read.git(f, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"]);
    if (!r.ok) continue;
    const [top, gitDir, common] = r.out.trim().split("\n");
    if (resolve(top ?? "") === f && resolve(f, gitDir ?? "") === resolve(f, common ?? "")) out.push(f);
  }
  return out;
}

/** One pass over every tracked repo. Each project is its own unit: a failure is in its meta row and
 *  never stops the others. */
export async function runScan(d: ScanDeps): Promise<void> {
  const scanned = new Set<string>();
  for (const folder of await trackedRepos(d)) {
    const project = basename(folder);
    scanned.add(project);
    try {
      await scanProject(d, folder, project);
    } catch (e) {
      writeMeta(d, project, { github: true, counts: {}, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // A repo that is gone (deleted or moved): nothing there needs the operator any more.
  for (const source of ["git", "github"] as const) {
    for (const project of d.ledger.attentionProjects(source)) {
      if (scanned.has(project)) continue;
      const rows = d.ledger.attentionRows(project, source);
      if (rows.length && rows.every((r) => !existsSync(r.folder))) reconcileScan(d.ledger, source, project, [], new Set(), d.now());
    }
  }
}

async function scanProject(d: ScanDeps, folder: string, project: string): Promise<void> {
  const now = d.now();
  const cfg = d.projects[project] ?? {};
  const openDirty = d.ledger.attentionRows(project, "git").find((r) => r.kind === "dirty" && r.key === folder && r.resolvedAt === undefined);
  const git = await gitDrafts(d.read, {
    folder,
    project,
    cfg,
    staleBranchDays: d.attention.staleBranchDays,
    worktreeIdleHours: d.attention.worktreeIdleHours,
    now,
    sessionIn: (f) => d.registry.findByFolder(f)?.status === "running",
    lastWorkAt: (f) => d.ledger.lastOrderAt(f),
    dirtyHigh: openDirty?.severity === "high",
    ...(openDirty?.severity === "high" ? { dirtyKeep: { title: openDirty.title, ...(openDirty.detail ? { detail: openDirty.detail } : {}) } } : {}),
  });
  reconcileScan(d.ledger, "git", project, git.drafts, new Set([...git.failed, ...git.kept]), now);
  const gh = await githubDrafts(d.read, { folder, project, cfg, tracked: git.tracked });
  reconcileScan(d.ledger, "github", project, gh.drafts, new Set([...gh.failed, ...gh.partial, ...gh.unavailable]), now);
  const counts: Record<string, number> = {};
  for (const x of [...git.drafts, ...gh.drafts]) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
  const failed = [...git.failed, ...gh.failed];
  const error = failed.length ? gh.error ?? `could not read: ${failed.join(", ")}` : undefined;
  writeMeta(d, project, { github: gh.github, counts, ...(error ? { error } : {}) }, failed.length === 0);
}

function writeMeta(d: ScanDeps, project: string, m: Omit<ScanMeta, "lastScanAt" | "lastGoodAt" | "errorEventAt">, good = false): void {
  const now = d.now();
  const key = `gh:${project}`;
  const prev = d.ledger.getMeta(key)?.value as ScanMeta | undefined;
  let errorEventAt = prev?.errorEventAt;
  if (m.error && (errorEventAt === undefined || now - errorEventAt >= HOUR)) {
    d.ledger.recordEvent("github_scan_error", { at: now, data: { project, error: m.error } });
    errorEventAt = now;
  }
  const meta: ScanMeta = {
    ...m,
    lastScanAt: now,
    ...(good ? { lastGoodAt: now } : prev?.lastGoodAt !== undefined ? { lastGoodAt: prev.lastGoodAt } : {}),
    ...(errorEventAt !== undefined ? { errorEventAt } : {}),
  };
  d.ledger.setMeta(key, meta, now);
}
