// The toolchain updater (ADR-0009). Keeps the worker Agent SDK, the Claude Code plugins and the MCP
// servers current. Deterministic: a fixed procedure per category, no AI. Each category is one
// `UpdateSource`; this file is the orchestration around them — scheduling (`due`), single-flight
// runs, the ledger record (`update_*` events), the operator report, `/updates` status and rollback.
// Every process / network / file call goes through the injected `UpdateSys` port (update-sys.ts is
// the real one), so every rule here is unit-tested.
import type { Ledger } from "./ledger";
import { isDue } from "./trigger";

export type UpdateCategory = "sdk" | "plugins" | "mcp";
export const UPDATE_CATEGORIES: readonly UpdateCategory[] = ["sdk", "plugins", "mcp"];

/** What happened to one update item in one run. */
export type UpdateOutcome =
  | "up_to_date" // already the latest
  | "applied" // replaced and verified
  | "merged" // sdk: bumped on a branch, green, fast-forwarded into the base branch
  | "available" // newer exists, auto-apply is off for its category
  | "held" // newer exists, its release notes flag a breaking change
  | "deferred" // newer may exist, but a session is running — retried when the engine is idle
  | "rolled_back" // applied, verification failed, the old version is back
  | "failed" // the update could not be done; nothing changed
  | "skipped" // deliberately not tried (e.g. this version already failed)
  | "floating" // names no version — resolves at launch, nothing to apply
  | "report_only"; // pinned in a place the updater does not edit (another project's tracked file)

export interface ItemResult {
  category: UpdateCategory;
  /** Stable item id, e.g. "@anthropic-ai/claude-agent-sdk", "superpowers@claude-plugins-official". */
  id: string;
  outcome: UpdateOutcome;
  from?: string;
  to?: string;
  detail?: string;
  /** Release-note lines that flag a breaking change. */
  breaking?: string[];
  /** The change only reaches running code after a daemon restart (the operator's call). */
  restartNeeded?: boolean;
  /** What a later `/updates rollback` needs (old path, old image id, …). Stored on the event. */
  undo?: Record<string, unknown>;
}

export interface RunContext {
  /** Apply what is newer (false → report it as `available`). */
  autoApply: boolean;
  /** Hold a version whose release notes flag a breaking change. */
  holdBreaking: boolean;
  /** A session is mid-task: anything that replaces files a session may read must wait. */
  busy: boolean;
  /** `/updates apply <item>`: only this item, and apply it even if held. */
  only?: string;
  force: boolean;
  /** The last recorded result for an item (e.g. "this version already failed"). */
  lastResult(id: string): ItemResult | undefined;
}

export interface UpdateSource {
  category: UpdateCategory;
  run(ctx: RunContext): Promise<ItemResult[]>;
  /** Put an item back to the version recorded on its last applied/merged result. */
  rollback(last: ItemResult): Promise<ItemResult>;
}

export interface ExecResult {
  code: number;
  out: string;
  err: string;
}

/** A stdio MCP server launch, as configured. */
export interface McpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Everything the updater does to the outside world. */
export interface UpdateSys {
  exec(cmd: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  fetchText(url: string): Promise<string | undefined>;
  download(url: string, dest: string): Promise<boolean>;
  sha256(path: string): string | undefined;
  readFile(path: string): string | undefined;
  /** Atomic write (temp file + rename). */
  writeFile(path: string, text: string): void;
  exists(path: string): boolean;
  copyFile(from: string, to: string): void;
  rename(from: string, to: string): void;
  listDir(path: string): string[];
  /** Start the server, run `initialize` + `tools/list`, stop it. */
  probeMcp(launch: McpLaunch, timeoutMs: number): Promise<{ ok: boolean; tools: number; error?: string }>;
}

export interface UpdatesCfg {
  enabled: boolean;
  /** How often the scheduled check runs. */
  everyMs: number;
  autoApply: Record<UpdateCategory, boolean>;
  holdBreaking: boolean;
  /** How soon a run that deferred items (a session was busy) is retried. */
  retryDeferredMs: number;
}

export interface Updater {
  /** Is a scheduled run due now (the interval passed, or deferred items wait and the retry passed)? */
  due(now: number): boolean;
  /** Run every category (or one item with `only`). Single-flight: a second call while one runs
   *  returns undefined at once. Returns the operator report. */
  run(opts: { trigger: "schedule" | "manual"; only?: string; force?: boolean }): Promise<string | undefined>;
  rollback(id: string): Promise<string>;
  /** `/updates` text: the last run and every item's latest result. */
  status(): string;
  running(): boolean;
}

export interface UpdaterDeps {
  ledger: Pick<Ledger, "recordEvent" | "listEvents">;
  sources: UpdateSource[];
  cfg: () => UpdatesCfg;
  /** True while any session runs a turn or a dispatch (plugins/MCP must not change under it). */
  busy: () => boolean;
  /** One message per run to the operator. */
  report: (text: string) => void;
  now?: () => number;
}

/** Events kept per run in the ledger. */
const RESULT_EVENT = "update_result";
const RUN_EVENT = "update_run";
/** Results scanned to build the per-item status. */
const STATUS_SCAN = 500;

const ICON: Record<UpdateOutcome, string> = {
  up_to_date: "✓",
  applied: "⬆",
  merged: "⬆",
  available: "•",
  held: "⏸",
  deferred: "⏳",
  rolled_back: "↩",
  failed: "✗",
  skipped: "–",
  floating: "~",
  report_only: "•",
};

/** One line per result: `⬆ plugins superpowers@x 6.4.1 → 6.5.0 — detail`. */
export function resultLine(r: ItemResult): string {
  const ver = r.from && r.to && r.from !== r.to ? ` ${r.from} → ${r.to}` : r.from ? ` ${r.from}` : r.to ? ` ${r.to}` : "";
  const extra = [r.detail, r.restartNeeded ? "restart needed" : undefined].filter(Boolean).join("; ");
  return `${ICON[r.outcome]} ${r.category} ${r.id}${ver} [${r.outcome}]${extra ? ` — ${extra}` : ""}`;
}

/** The operator report for one run: changes and problems first, quiet items counted, not listed. */
export function renderReport(results: ItemResult[], trigger: string): string {
  const loud = results.filter((r) => !["up_to_date", "floating", "report_only"].includes(r.outcome));
  const quiet = results.length - loud.length;
  const lines = [`🔄 Update check (${trigger}): ${loud.length ? `${loud.length} to note` : "nothing changed"}, ${quiet} current/unmanaged`];
  for (const r of loud) {
    lines.push(resultLine(r));
    for (const b of (r.breaking ?? []).slice(0, 3)) lines.push(`    ⚠ ${b}`);
  }
  const restart = results.filter((r) => r.restartNeeded);
  if (restart.length) lines.push(`Restart needed for: ${restart.map((r) => r.id).join(", ")} — Neo does not restart by itself.`);
  return lines.join("\n");
}

// --- release notes ---------------------------------------------------------------------------------

/** Compare dotted versions numerically (`0.3.289` > `0.3.86`); non-numeric parts compare as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.+-]/);
  const pb = b.replace(/^v/, "").split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

/** The body of every `## <version>` section of a markdown changelog newer than `from` and up to `to`. */
export function notesBetween(changelog: string, from: string, to: string): string[] {
  const out: string[] = [];
  let keep = false;
  for (const line of changelog.split("\n")) {
    const h = /^#{1,3}\s*\[?v?(\d[\w.+-]*)\]?/.exec(line);
    if (h) {
      keep = compareVersions(h[1], from) > 0 && compareVersions(h[1], to) <= 0;
      continue;
    }
    if (keep && line.trim()) out.push(line.trim());
  }
  return out;
}

/** Release-note wording that announces a breaking change. Deliberately narrow: "Fixed … when X was
 *  removed" is a fix, not a break, so a bare "removed" only counts as the entry's first word. */
const BREAKING = [
  /\bbreaking\b/i,
  /\bincompatib/i,
  /\bmigration (guide|required|needed)\b|\bmust migrate\b/i,
  /\brebuild\b/i,
  /\bno longer (supported|accepted|works|available)\b/i,
  /^(removed|dropped)\b/i,
];
export function breakingLines(notes: string[]): string[] {
  return notes
    .map((l) => l.replace(/^[-*]\s*/, ""))
    .filter((l) => BREAKING.some((re) => re.test(l)))
    .map((l) => l.slice(0, 200));
}

// --- the orchestrator ------------------------------------------------------------------------------

export function createUpdater(d: UpdaterDeps): Updater {
  const now = d.now ?? (() => Date.now());
  let inFlight = false;

  const results = (limit = STATUS_SCAN): Array<ItemResult & { at: number }> =>
    d.ledger.listEvents({ kind: RESULT_EVENT, limit }).map((e) => ({ ...(e.data as unknown as ItemResult), at: e.at }));
  const lastRun = () => d.ledger.listEvents({ kind: RUN_EVENT, limit: 1 })[0];
  const lastResult = (id: string) => results().find((r) => r.id === id);

  const run: Updater["run"] = async (opts) => {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      const cfg = d.cfg();
      const all: ItemResult[] = [];
      for (const source of d.sources) {
        const ctx: RunContext = {
          autoApply: cfg.autoApply[source.category] || !!opts.force,
          holdBreaking: cfg.holdBreaking && !opts.force,
          busy: d.busy(),
          only: opts.only,
          force: !!opts.force,
          lastResult,
        };
        try {
          all.push(...(await source.run(ctx)));
        } catch (e) {
          // One category failing never stops the others.
          all.push({ category: source.category, id: source.category, outcome: "failed", detail: e instanceof Error ? e.message : String(e) });
        }
      }
      const at = now();
      for (const r of all) d.ledger.recordEvent(RESULT_EVENT, { at, data: { ...r } });
      d.ledger.recordEvent(RUN_EVENT, {
        at,
        data: { trigger: opts.trigger, only: opts.only ?? null, deferred: all.some((r) => r.outcome === "deferred"), items: all.length },
      });
      if (opts.only && all.length === 0) {
        const text = `No update item named "${opts.only}". See /updates for the item ids.`;
        d.report(text);
        return text;
      }
      const text = renderReport(all, opts.only ? `apply ${opts.only}` : opts.trigger);
      d.report(text);
      return text;
    } finally {
      inFlight = false;
    }
  };

  return {
    due(t) {
      const cfg = d.cfg();
      if (!cfg.enabled || inFlight) return false;
      const last = lastRun();
      if (!last) return true; // never ran: due now
      if (isDue({ kind: "interval", everyMs: cfg.everyMs }, last.at, t)) return true;
      return last?.data?.deferred === true && !d.busy() && t - last.at >= cfg.retryDeferredMs;
    },
    run,
    async rollback(id) {
      const last = results().find((r) => r.id === id && (r.outcome === "applied" || r.outcome === "merged"));
      if (!last) return `No applied update for "${id}" to roll back.`;
      const source = d.sources.find((s) => s.category === last.category);
      if (!source) return `No updater for category ${last.category}.`;
      if (last.category !== "sdk" && d.busy()) return `A session is running — roll back ${id} when the engine is idle.`;
      let r: ItemResult;
      try {
        r = await source.rollback(last);
      } catch (e) {
        r = { category: last.category, id, outcome: "failed", detail: `rollback: ${e instanceof Error ? e.message : String(e)}` };
      }
      d.ledger.recordEvent(RESULT_EVENT, { at: now(), data: { ...r } });
      const text = `↩ rollback: ${resultLine(r)}`;
      d.report(text);
      return text;
    },
    status() {
      const last = lastRun();
      const cfg = d.cfg();
      const seen = new Set<string>();
      const latest = results().filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
      const head = last
        ? `Last update run: ${new Date(last.at).toISOString().slice(0, 16).replace("T", " ")} UTC (${String(last.data?.trigger ?? "?")})`
        : "No update run yet.";
      const auto = UPDATE_CATEGORIES.map((c) => `${c} ${cfg.autoApply[c] ? "on" : "off"}`).join(" · ");
      const lines = [
        `${head}${inFlight ? " — a run is in progress" : ""}`,
        `Scheduled: ${cfg.enabled ? `every ${Math.round(cfg.everyMs / 3_600_000)}h` : "off"} · auto-apply: ${auto} · hold breaking: ${cfg.holdBreaking ? "on" : "off"}`,
      ];
      for (const c of UPDATE_CATEGORIES) {
        const items = latest.filter((r) => r.category === c);
        if (items.length) lines.push(`${c}:`, ...items.map((r) => `  ${resultLine(r)}`));
      }
      lines.push("/updates run · /updates apply <item> · /updates rollback <item>");
      return lines.join("\n");
    },
    running: () => inFlight,
  };
}
