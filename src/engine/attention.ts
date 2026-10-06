/** What needs the operator (ADR-0018, spec §7): every producer — git, GitHub, the engine, plans, the
 *  restart check — reports its findings as drafts, and this module reconciles them against that
 *  producer's rows for one project. New → open; still there → seen again; gone → resolved; back →
 *  the same row reopens. Plain code over the ledger — no AI. */
import type { AttentionDraft, AttentionRow, AttentionSource, Ledger } from "./ledger";

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
      const row = rows.get(k);
      const fields = { folder: d.folder, title: d.title, detail: d.detail ?? null, url: d.url ?? null, severity: d.severity, lastSeen: now };
      if (!row) opened.push(ledger.insertAttention({ ...d, project, source }, now));
      else if (row.resolvedAt === undefined) ledger.updateAttention(row.id, fields);
      else if (row.dismissed) ledger.updateAttention(row.id, { lastSeen: now }); // closed by the operator: stays closed while it is still there
      else {
        ledger.updateAttention(row.id, { ...fields, resolvedAt: null, snoozedUntil: null });
        opened.push(row.id);
      }
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

/** Hide an open item until `untilMs`. */
export function snooze(ledger: Ledger, id: number, untilMs: number): void {
  ledger.updateAttention(id, { snoozedUntil: untilMs });
}

/** The operator closes an item: resolved now, and not reopened until its key disappears and comes back. */
export function dismiss(ledger: Ledger, id: number, now: number): void {
  ledger.updateAttention(id, { resolvedAt: now, dismissed: true });
}

/** Open items not snoozed at `now`: severity first, then newest seen; bounded. */
export function listOpen(ledger: Ledger, f: { project?: string; now: number; limit?: number }): AttentionRow[] {
  return ledger.listOpenAttention(f);
}
