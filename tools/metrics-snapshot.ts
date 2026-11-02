// The ledger metrics snapshot (plan 2026-11-02 W0.7): the "before" numbers each later phase is measured
// against, read from the ledger and nothing else. Read-only by construction: the database is opened
// with `readonly: true` (the backup's precedent), so this tool can run against the live ledger while
// the daemon runs (HANDOFF: never open data/ledger.db for writing).
//
//   bun tools/metrics-snapshot.ts [--ledger <path>] [--days <n>] [--json]
//
// What it reports today, and what it says it cannot report yet (each later phase fills a line in):
//   dispatches      count · ok · failed · estimated usage units per dispatch (the SDK's cost estimate,
//                   a proxy on a subscription: there is no invoice; W4.1 replaces it with tokens)
//   interventions   decisions and approvals attributed to a dispatch, per dispatch
//   claim ≠ verdict n/a until W1.3 · reopened incidents n/a until W2.8 · merged PRs n/a until W3.6
//   window share    n/a until W4.1 (rate-limit events are in memory only today)
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LEDGER_PATH } from "../src/engine/ledger";

/** The slice of a database this tool reads: one `query(sql).all(...params)` shape, so a test can
 *  hand it a real ledger file and a reviewer can see every statement is a SELECT. */
export interface ReadOnlyDb {
  query(sql: string): { all(...params: Array<string | number>): unknown[] };
}

export interface MetricsSnapshot {
  from: number;
  to: number;
  dispatches: {
    count: number;
    ok: number;
    failed: number;
    /** Sum of the SDK's `costUsd` estimates: a usage proxy, not money. */
    estUsageUnits: number;
    estUsageUnitsPerDispatch: number | null;
  };
  interventions: {
    /** `ask_operator` questions raised by a dispatched order (decisions with its order id). */
    decisions: number;
    /** Governor approvals raised while a dispatched session ran (no order id; matched by session). */
    approvals: number;
    perDispatch: number | null;
  };
  /** Lines a later phase fills in; each names the phase, so a reader knows why it is empty. */
  pending: Record<string, string>;
}

const PENDING: Record<string, string> = {
  claimVsVerdictRate: "n/a until W1.3 (claim and verdict columns)",
  tokensPerVerifiedTask: "n/a until W1.12 (verdicts) and W4.1 (token accounting)",
  reopenedIncidents: "n/a until W2.8 (incidents table)",
  mergedPrsPerWeek: "n/a until W3.6 (pr_links table)",
  windowShare: "n/a until W4.1 (rate-limit utilisation is in memory only today)",
};

/** Read the snapshot for `[from, to]`. Pure over the database: only SELECTs, no clock of its own. */
export function metricsSnapshot(db: ReadOnlyDb, opts: { from: number; to: number }): MetricsSnapshot {
  const ends = db
    .query(`SELECT order_id, session_id, data FROM events WHERE kind = 'dispatch_end' AND at >= ? AND at <= ?`)
    .all(opts.from, opts.to) as Array<{ order_id: string | null; session_id: string | null; data: string | null }>;

  let ok = 0;
  let failed = 0;
  let est = 0;
  const orderIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const e of ends) {
    let data: Record<string, unknown> = {};
    try {
      data = e.data ? (JSON.parse(e.data) as Record<string, unknown>) : {};
    } catch {
      data = {}; // a malformed row counts as a dispatch with nothing known about it
    }
    if (data.ok === true) ok++;
    else failed++;
    if (typeof data.costUsd === "number" && Number.isFinite(data.costUsd)) est += data.costUsd;
    if (e.order_id) orderIds.add(e.order_id);
    if (e.session_id) sessionIds.add(e.session_id);
  }
  const count = ends.length;

  const decisions = countIn(db, "order_id", orderIds, "decision");
  const approvals = countIn(db, "session_id", sessionIds, "approval");

  return {
    from: opts.from,
    to: opts.to,
    dispatches: {
      count,
      ok,
      failed,
      estUsageUnits: round(est),
      estUsageUnitsPerDispatch: count ? round(est / count) : null,
    },
    interventions: { decisions, approvals, perDispatch: count ? round((decisions + approvals) / count) : null },
    pending: { ...PENDING },
  };
}

/** Decisions whose `column` is one of `ids`. `which`: `decision` = raised by an order (has an order
 *  id); `approval` = a governor approval (no order id), matched to the dispatched session. Chunked so
 *  a wide window never builds one unbounded IN list. */
function countIn(db: ReadOnlyDb, column: "order_id" | "session_id", ids: Set<string>, which: "decision" | "approval"): number {
  if (ids.size === 0) return 0;
  const list = [...ids];
  const orderFilter = which === "decision" ? "AND order_id IS NOT NULL" : "AND order_id IS NULL";
  let total = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const marks = chunk.map(() => "?").join(",");
    const row = db
      .query(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'decision' ${orderFilter} AND ${column} IN (${marks})`)
      .all(...chunk) as Array<{ n: number }>;
    total += row[0]?.n ?? 0;
  }
  return total;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function renderSnapshot(s: MetricsSnapshot): string {
  const d = s.dispatches;
  const i = s.interventions;
  const per = (v: number | null) => (v === null ? "—" : String(v));
  const lines = [
    `Metrics snapshot ${new Date(s.from).toISOString().slice(0, 10)} → ${new Date(s.to).toISOString().slice(0, 10)}`,
    `dispatches: ${d.count} (ok ${d.ok}, failed ${d.failed}) · est. usage units ${d.estUsageUnits} · per dispatch ${per(d.estUsageUnitsPerDispatch)}`,
    `interventions: decisions ${i.decisions}, approvals ${i.approvals} · per dispatch ${per(i.perDispatch)}`,
    ...Object.entries(s.pending).map(([k, v]) => `${k}: ${v}`),
  ];
  return lines.join("\n");
}

/** Open a ledger file read-only. Throws when the file is missing (there is nothing to measure). */
export function openReadOnly(path: string): ReadOnlyDb {
  if (!existsSync(path)) throw new Error(`no ledger at ${path}`);
  return new Database(path, { readonly: true });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const ledger = arg("--ledger") ?? LEDGER_PATH;
  const days = Number(arg("--days") ?? 7);
  const to = Date.now();
  const from = to - (Number.isFinite(days) && days > 0 ? days : 7) * 86_400_000;
  const snap = metricsSnapshot(openReadOnly(ledger), { from, to });
  console.log(args.includes("--json") ? JSON.stringify(snap, null, 2) : renderSnapshot(snap));
}
