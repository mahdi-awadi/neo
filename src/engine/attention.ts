/** What needs the operator (ADR-0018, spec §7): every producer — git, GitHub, the engine, plans, the
 *  restart check — reports its findings as drafts, and this module reconciles them against that
 *  producer's rows for one project. New → open; still there → seen again; gone → resolved; back →
 *  the same row reopens. Plain code over the ledger — no AI. */
import type { AttentionDraft, AttentionRow, AttentionSource, Ledger } from "./ledger";
import { faults } from "./fault";

export type { AttentionDraft, AttentionRow, AttentionSeverity, AttentionSource } from "./ledger";

/** Reconcile one producer's view of one project. `"error"`: the producer could not read its source
 *  (gh offline, git failed) — nothing changes, so a failed read never resolves anything. One
 *  transaction: a crash mid-way leaves the previous state. */
export function reconcile(
  ledger: Ledger,
  source: AttentionSource,
  project: string,
  drafts: AttentionDraft[] | "error",
  now: number,
): { opened: number[]; resolved: number[] } {
  const opened: number[] = [];
  const resolved: number[] = [];
  if (drafts === "error") return { opened, resolved };
  ledger.transaction(() => {
    const rows = new Map(ledger.attentionRows(project, source).map((r) => [`${r.kind}\0${r.key}`, r]));
    const seen = new Set<string>();
    for (const d of drafts) {
      const k = `${d.kind}\0${d.key}`;
      if (seen.has(k)) continue; // a producer that reports a key twice: the first wins
      seen.add(k);
      const r = upsert(ledger, rows.get(k), { ...d, project, source }, now);
      if (r.opened) opened.push(r.id);
    }
    for (const [k, row] of rows) {
      if (seen.has(k)) continue;
      if (row.resolvedAt === undefined) {
        ledger.updateAttention(row.id, { resolvedAt: now });
        resolved.push(row.id);
      } else if (row.dismissed) ledger.updateAttention(row.id, { dismissed: false }); // gone: its next return reopens it
    }
  });
  return { opened, resolved };
}

/** One draft against its row (if any): new → insert; open → refresh; resolved → reopen (the same row);
 *  dismissed by the operator → stays closed while it is still there. */
function upsert(ledger: Ledger, row: AttentionRow | undefined, d: AttentionDraft, now: number): { id: number; opened: boolean } {
  if (!row) return { id: ledger.insertAttention(d, now), opened: true };
  const fields = { folder: d.folder, title: d.title, detail: d.detail ?? null, url: d.url ?? null, severity: d.severity, lastSeen: now };
  if (row.resolvedAt === undefined) ledger.updateAttention(row.id, fields);
  else if (row.dismissed) ledger.updateAttention(row.id, { lastSeen: now });
  else {
    // Back after it resolved: a new occurrence — its old snooze and old todo are not this one's.
    ledger.updateAttention(row.id, { ...fields, resolvedAt: null, snoozedUntil: null, todoId: null });
    return { id: row.id, opened: true };
  }
  return { id: row.id, opened: false };
}

/** Raise ONE finding seen at a moment (not by a scan) — e.g. files left uncommitted when a todo ended.
 *  Opens or refreshes its item and leaves the source's other items alone; the source's own producer
 *  resolves it later, when its scan no longer sees it. Returns the item id. */
export function raise(ledger: Ledger, d: AttentionDraft, now: number): number {
  return ledger.transaction(() => {
    const row = ledger.attentionRows(d.project, d.source).find((r) => r.kind === d.kind && r.key === d.key);
    return upsert(ledger, row, d, now).id;
  });
}

/** Reconcile one producer's drafts across every project it reports, plus every project where it still
 *  has a live row — so an item whose project now reports nothing is resolved too. `"error"` changes
 *  nothing anywhere. Each project is its own unit (ADR-0010): one that fails is reported and the
 *  others still reconcile. `keepResolvedMs`: this source's rows resolved longer ago are pruned. */
export function reconcileAll(
  ledger: Ledger,
  source: AttentionSource,
  drafts: AttentionDraft[] | "error",
  now: number,
  opts: { keepResolvedMs?: number } = {},
): { opened: number[]; resolved: number[] } {
  const opened: number[] = [];
  const resolved: number[] = [];
  if (drafts === "error") return { opened, resolved };
  const byProject = new Map<string, AttentionDraft[]>();
  for (const p of ledger.attentionProjects(source)) byProject.set(p, []);
  for (const d of drafts) byProject.set(d.project, [...(byProject.get(d.project) ?? []), d]);
  for (const [project, list] of byProject) {
    faults.guard(`attention.reconcile.${source}`, () => {
      const r = reconcile(ledger, source, project, list, now);
      opened.push(...r.opened);
      resolved.push(...r.resolved);
    }, { project });
  }
  if (opts.keepResolvedMs !== undefined) {
    const before = now - opts.keepResolvedMs;
    faults.guard(`attention.prune.${source}`, () => ledger.pruneAttention(source, before));
  }
  return { opened, resolved };
}

/** The live rows (open, or dismissed and still remembered) of `kinds` — carried into a reconcile as
 *  drafts when their read failed, so a failed read never resolves them (spec §7). `project`
 *  undefined: every project of the source. */
export function liveDrafts(ledger: Ledger, source: AttentionSource, kinds: ReadonlySet<string>, project?: string): AttentionDraft[] {
  if (!kinds.size) return [];
  const out: AttentionDraft[] = [];
  for (const p of project !== undefined ? [project] : ledger.attentionProjects(source)) {
    for (const r of ledger.attentionRows(p, source)) {
      if (!kinds.has(r.kind) || (r.resolvedAt !== undefined && !r.dismissed)) continue;
      out.push({ project: r.project, folder: r.folder, source, kind: r.kind, key: r.key, title: r.title, detail: r.detail, url: r.url, severity: r.severity });
    }
  }
  return out;
}

/** One project's scan: the kinds that were read reconcile; the kinds whose read failed keep their
 *  live rows as they are. */
export function reconcileScan(
  ledger: Ledger,
  source: AttentionSource,
  project: string,
  drafts: AttentionDraft[],
  failedKinds: ReadonlySet<string>,
  now: number,
): { opened: number[]; resolved: number[] } {
  return reconcile(ledger, source, project, [...drafts, ...liveDrafts(ledger, source, failedKinds, project)], now);
}

/** Hide an open item until `untilMs`. */
export function snooze(ledger: Ledger, id: number, untilMs: number): void {
  ledger.updateAttention(id, { snoozedUntil: untilMs });
}

/** The operator closes an item: resolved now, and not reopened until its key disappears and comes back.
 *  Dismissing an item the producer already resolved works the same way: if its key returns while
 *  still remembered, it stays closed. */
export function dismiss(ledger: Ledger, id: number, now: number): void {
  ledger.updateAttention(id, { resolvedAt: now, dismissed: true });
}

/** Open items not snoozed at `now`: severity first, then newest seen; bounded. */
export function listOpen(ledger: Ledger, f: { project?: string; now: number; limit?: number }): AttentionRow[] {
  return ledger.listOpenAttention(f);
}
