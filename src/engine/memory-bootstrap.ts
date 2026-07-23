// Bootstrap: don't start a project's memory from zero. Deterministic, no AI — seeds the daily
// log from what the engine already knows about this folder: (a) recorded ledger outcomes, and
// (b) an existing HANDOFF.md handoff note. Runs once per folder, guarded by a sentinel file, so
// a re-run (daemon restart, re-`/open`, or the CLI entry point) is always a safe no-op.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "./ledger";
import { appendDailyLog, memoryDir, scanMemoryText } from "./memory";

/** Result of one bootstrap attempt. `imported` counts lines actually appended to the log (a line
 * that fails the write-time scan is dropped and does NOT count). `skipped` is true when the
 * sentinel already existed and nothing ran. */
export interface BootstrapResult {
  imported: number;
  skipped: boolean;
}

function sentinelPath(folder: string): string {
  return join(memoryDir(folder), ".bootstrapped");
}

/** Converts an epoch-ms timestamp to a local YYYY-MM-DD date string (matches memory.ts's
 * `todayLocalDate` convention, just parameterized on an arbitrary timestamp). */
function localDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Appends `line` via appendDailyLog (which itself re-applies the scan and indexes on success),
 * but pre-checks the scan here so the caller can count only lines that actually landed —
 * appendDailyLog itself returns void and silently drops scan-failing lines. */
function importLine(folder: string, line: string, day?: string): boolean {
  if (scanMemoryText(line)) return false; // would be silently dropped by appendDailyLog — don't count it
  appendDailyLog(folder, line, day);
  return true;
}

/** Seeds `folder`'s memory log from ledger outcomes + HANDOFF.md, once. No AI, fully
 * deterministic — see docs/superpowers/sdd task 8. `now` is injectable for tests. */
export function bootstrapMemory(folder: string, ledger: Ledger, now: () => number = Date.now): BootstrapResult {
  const sentinel = sentinelPath(folder);
  if (existsSync(sentinel)) return { imported: 0, skipped: true };

  let imported = 0;

  // (a) Ledger outcomes recorded for this folder — one dated log line each.
  for (const row of ledger.outcomesForFolder(folder)) {
    const text = row.summary && row.summary.trim() !== "" ? row.summary : row.status;
    if (importLine(folder, `[bootstrap] ${text}`, localDate(row.at))) imported++;
  }

  // (b) An existing HANDOFF.md — every non-empty line imported verbatim into today's log.
  const handoffPath = join(folder, "HANDOFF.md");
  if (existsSync(handoffPath)) {
    let content = "";
    try {
      content = readFileSync(handoffPath, "utf-8");
    } catch {
      content = ""; // best-effort — an unreadable HANDOFF.md contributes nothing
    }
    for (const raw of content.split("\n")) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      if (importLine(folder, `[bootstrap] HANDOFF: ${trimmed}`)) imported++;
    }
  }

  // Sentinel is written even when nothing was importable — this folder has still been
  // "bootstrapped" (a re-run must never re-import).
  try {
    mkdirSync(memoryDir(folder), { recursive: true });
    writeFileSync(sentinel, new Date(now()).toISOString(), "utf-8");
  } catch {
    // Best-effort — a failed sentinel write just risks a future re-import; the log lines
    // already written are unaffected.
  }

  return { imported, skipped: false };
}

// Production ledger DB path — mirrors the literal daemon.ts opens (`data/ledger.db`, relative to
// the daemon's working directory). No shared constant exists yet to import; kept identical to
// daemon.ts's own `openLedger("data/ledger.db")` call.
const PRODUCTION_LEDGER_PATH = "data/ledger.db";

if (import.meta.main) {
  const folder = process.argv[2];
  if (!folder) {
    console.log("usage: bun run src/engine/memory-bootstrap.ts <folder>");
    process.exit(1);
  }
  const { openLedger } = await import("./ledger");
  const ledger = openLedger(PRODUCTION_LEDGER_PATH);
  const result = bootstrapMemory(folder, ledger);
  console.log(
    result.skipped
      ? `bootstrap: skipped (already bootstrapped: ${sentinelPath(folder)})`
      : `bootstrap: imported ${result.imported} line(s) into ${folder}/memory/log`,
  );
}
