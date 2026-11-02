/** Superseded items (ADR-0065): an open attention item made pointless by a newer one — the same project,
 *  the same kind and the same stem (a branch, key or dependency name with its trailing version removed),
 *  with a lower version than an open sibling. `chore/agent-sdk-0.3.303` waits to merge while
 *  `chore/agent-sdk-0.3.312` does too: only the newest stays. The engine resolves the older one as
 *  dismissed (so the next scan that still sees it keeps it closed) with the reason in `resolution`. It
 *  deletes no branch and closes no PR. Plain code, no AI. */
import type { AttentionRow, Ledger } from "./ledger";
import { explainAttention } from "./attention-explain";

/** A name split into its stem and trailing version: `chore/agent-sdk-0.3.312` → `chore/agent-sdk`,
 *  [0, 3, 312]. Undefined when the name has no trailing version. */
export function stemOf(name: string): { stem: string; version: number[] } | undefined {
  // The version follows a separator (`-`, `_`, `@`, `/`), with an optional `v`, and has a dot: a plain
  // number (`fix/issue-12`, `feature/123`) is an id of separate work, never a version.
  const m = /^(.+?)[-_@/]v?(\d+(?:\.\d+)+)$/.exec(name);
  return m ? { stem: m[1]!, version: m[2]!.split(".").map(Number) } : undefined;
}

/** The kinds named by a branch (or a dependency PR's package): only these can be superseded. A key that
 *  is an id (`todo:903`, a thread, an alert number) never is. */
const SUPERSEDABLE: ReadonlySet<string> = new Set(["restart_gated", "stale_branch", "unpushed", "no_upstream", "pr_open"]);

/** Numeric, part by part; a missing part is 0 (`1.0` equals `1.0.0`). */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** What an item is a version of: a dependency PR by its package and target version, any other item by
 *  its key. */
function identity(r: AttentionRow): { stem: string; version: number[] } | undefined {
  if (!SUPERSEDABLE.has(r.kind)) return undefined;
  if (r.kind === "pr_open") {
    const f = explainAttention(r).facts;
    if (typeof f.dep === "string" && f.to !== undefined) {
      const v = /^v?(\d+(?:\.\d+)*)/.exec(String(f.to));
      // A monorepo bumps one package per folder ("… in /app"): the folder is part of what it is.
      const dir = /\sin\s(\/\S*)\s*$/.exec(String(f.prTitle ?? ""))?.[1] ?? "";
      return v ? { stem: `dep:${f.dep}@${dir}`, version: v[1]!.split(".").map(Number) } : undefined;
    }
  }
  return r.kind === "pr_open" ? undefined : stemOf(r.key);
}

/** Which open rows a newer open sibling supersedes. Pure: rows already closed never supersede or count. */
export function supersededBy(rows: AttentionRow[]): Array<{ id: number; by: number }> {
  const groups = new Map<string, Array<{ row: AttentionRow; version: number[] }>>();
  for (const row of rows) {
    if (row.resolvedAt !== undefined) continue;
    const id = identity(row);
    if (!id) continue;
    const k = `${row.project}\0${row.kind}\0${id.stem}`;
    groups.set(k, [...(groups.get(k) ?? []), { row, version: id.version }]);
  }
  const out: Array<{ id: number; by: number }> = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const newest = g.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
    for (const x of g) if (x.row.id !== newest.row.id && compareVersions(x.version, newest.version) < 0) out.push({ id: x.row.id, by: newest.row.id });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Resolve one project's superseded items of one source, with the reason; returns their ids. Runs inside
 *  the caller's reconcile transaction. */
export function resolveSuperseded(ledger: Pick<Ledger, "attentionRows" | "updateAttention">, project: string, source: AttentionRow["source"], now: number): number[] {
  const rows = ledger.attentionRows(project, source);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const done: number[] = [];
  for (const { id, by } of supersededBy(rows)) {
    const newer = byId.get(by)!;
    const label = String(explainAttention(newer).facts.branch ?? newer.key.replace(/^merge:/, ""));
    const resolution = { how: "superseded", by, key: newer.key, reason: `superseded by #${by} (${label})`, at: now };
    ledger.updateAttention(id, { resolvedAt: now, dismissed: true, resolution: JSON.stringify(resolution) });
    done.push(id);
  }
  return done;
}
