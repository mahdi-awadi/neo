// The /loop command: a registry of named loops the operator can fire and the scheduler can run.
// Each loop bundles a folder, a worker prompt, a Goal (verifiable command or LLM-judge), a Trigger
// (manual/interval/cron), and Bounds (iterations + budget). /loop lists them; /loop <name> starts
// one now; /loop <name> on|off toggles its schedule. Work runs through runProjectLoop, so it's
// governed and escalation-auto-denied (never pushes/deploys). See docs/loops.md.
import { runProjectLoop, type Bounds } from "./project-loop";
import type { Goal, GoalCheck } from "./goal";
import type { Trigger } from "./trigger";
import type { SchedulableLoop, LoopStateStore } from "./scheduler";
import type { LoopOutcome } from "./loop-runner";
import type { runOrder } from "./session-runner";
import { validateLoopInput, type LoopInput } from "./loop-validate";

/** Persistence of operator-authored (custom) loop defs — opaque JSON keyed by name. */
export interface LoopDefStore {
  listLoopDefs(): Array<{ name: string; json: string }>;
  saveLoopDef(name: string, json: string): void;
  deleteLoopDef(name: string): void;
}
/** The ledger satisfies both halves; commands/UX take the combined store. */
export type LoopStore = LoopDefStore & LoopStateStore;

export interface LoopDef extends SchedulableLoop {
  name: string; // canonical key, e.g. "gold-gofmt"
  usage: string; // "/loop gold gofmt"
  summary: string;
  folder: string; // where the worker opens
  prompt: string; // what the worker attempts each iteration
  goal: Goal; // verifiable command or LLM-judge
  trigger: Trigger; // manual / interval / cron
  bounds: Bounds; // maxIterations + optional budgetUsd
  enabledByDefault?: boolean; // for scheduled loops
}

export interface LoopDeps {
  reply: (chatId: number, text: string) => void | Promise<void>;
  /** Injectable worker runner (tests); defaults to the real session-runner. */
  run?: typeof runOrder;
  /** Injectable goal (tests); defaults to the loop's Goal. */
  check?: GoalCheck;
  /** Throttle / kill-switch wired in by the daemon (meter.shouldThrottle). */
  shouldStop?: () => boolean;
  /** Loop store (def CRUD + state) for /loop <name> on|off, custom-loop run, and schedule status. */
  store?: LoopStore;
  now?: () => number;
}

const GOLD_GOFMT: LoopDef = {
  name: "gold-gofmt",
  usage: "/loop gold gofmt",
  summary: "format gold/server with gofmt and commit (never pushes)",
  folder: "/home/gold",
  prompt:
    "Run `gofmt -w server/` to fix Go formatting across the server module, then confirm `gofmt -l server/` prints nothing. Commit the formatting changes with a message like 'style: gofmt'. Do NOT push.",
  goal: { kind: "command", command: ["sh", "-c", 'test -z "$(gofmt -l server/)"'], timeoutMs: 60_000 },
  trigger: { kind: "manual" },
  bounds: { maxIterations: 3 },
};

const GREEN: LoopDef = {
  name: "green",
  usage: "/loop green",
  summary: "run bun test + tsc until green (never pushes)",
  folder: "/home/neo",
  prompt:
    "Run `bun test` and `bunx tsc --noEmit`. Diagnose and fix any failures you find, then re-run. Do NOT push or deploy.",
  goal: { kind: "command", command: ["sh", "-c", "bun test && bunx tsc --noEmit"], timeoutMs: 300_000 },
  trigger: { kind: "manual" },
  bounds: { maxIterations: 5, budgetUsd: 5 },
};

const ERROR_SWEEP: LoopDef = {
  name: "error-sweep",
  usage: "/loop error-sweep",
  summary: "nightly: scan logs, root-cause + fix unaddressed errors (never pushes)",
  folder: "/home/neo",
  prompt:
    "Scan `data/unaddressed-errors.log` and the app logs for errors. Root-cause and fix each one, committing per fix. Do NOT push or deploy.",
  goal: { kind: "command", command: ["sh", "-c", "test ! -s data/unaddressed-errors.log"], timeoutMs: 120_000 },
  trigger: { kind: "cron", expr: "30 3 * * *" },
  bounds: { maxIterations: 4, budgetUsd: 10 },
  enabledByDefault: false,
};

const DOCS_SWEEP: LoopDef = {
  name: "docs-sweep",
  usage: "/loop docs-sweep",
  summary: "nightly: sync docs to the day's diff — LLM-judge (never pushes)",
  folder: "/home/neo",
  prompt: "Review today's `git diff` and update the docs to match it. Commit the doc updates. Do NOT push.",
  goal: {
    kind: "judge",
    criteria:
      "The repo's docs accurately reflect today's code changes: every changed command, config flag, or public behavior is documented, and no doc references a removed feature.",
    timeoutMs: 120_000,
  },
  trigger: { kind: "cron", expr: "45 3 * * *" },
  bounds: { maxIterations: 3, budgetUsd: 10 },
  enabledByDefault: false,
};

const INBOX_DELETE: LoopDef = {
  name: "inbox-delete",
  usage: "/loop inbox-delete",
  summary: "add a delete button to the web frontend's inbox until tested green (never pushes)",
  folder: "/home/neo",
  prompt:
    "Add the ability to delete a customer-inbox item from the operator web frontend. Work TDD: first write `tests/inbox-delete.test.ts` covering (1) `Inbox.delete(id)` removes the item so `get(id)` returns undefined and it drops out of `list()`, and (2) the web frontend exposes a delete affordance and a `DELETE /api/inbox/:id` route that calls it. Then implement the minimal code to pass: add `delete(id)` to the `Inbox` interface + its bun:sqlite impl in `src/engine/inbox.ts`, a `DELETE /api/inbox/:id` handler in `src/frontends/web.ts`, and a delete button on each inbox row in the rendered console page that hits it. Keep `bunx tsc --noEmit` clean. Commit per logical piece. Do NOT push or deploy.",
  goal: {
    kind: "command",
    command: ["sh", "-c", "bun test tests/inbox-delete.test.ts && bunx tsc --noEmit"],
    timeoutMs: 300_000,
  },
  trigger: { kind: "manual" },
  bounds: { maxIterations: 6, budgetUsd: 8 },
};

export const LOOPS: LoopDef[] = [GOLD_GOFMT, GREEN, ERROR_SWEEP, DOCS_SWEEP, INBOX_DELETE];

export function isBuiltin(name: string): boolean {
  return LOOPS.some((l) => l.name === name);
}

function isLoopDef(x: unknown): x is LoopDef {
  const d = x as Record<string, unknown> | null;
  return !!d && typeof d.name === "string" && typeof d.folder === "string" && !!d.goal && !!d.trigger && !!d.bounds;
}

/** Built-in loops (code) ∪ custom loops (store). Built-ins win on a name clash; bad rows are skipped. */
export function effectiveLoops(store?: LoopDefStore): LoopDef[] {
  const rows = typeof store?.listLoopDefs === "function" ? store.listLoopDefs() : [];
  const builtinNames = new Set(LOOPS.map((l) => l.name));
  const custom: LoopDef[] = [];
  for (const row of rows) {
    if (builtinNames.has(row.name)) continue;
    try {
      const d = JSON.parse(row.json);
      if (isLoopDef(d)) custom.push(d);
    } catch {
      // skip a corrupt/hand-edited row rather than crash a scheduler tick
    }
  }
  return [...LOOPS, ...custom];
}

export function matchLoop(args: string, store?: LoopDefStore): LoopDef | undefined {
  const key = args.trim().toLowerCase().replace(/\s+/g, "-");
  return effectiveLoops(store).find((l) => l.name === key);
}

export interface LoopInfo {
  name: string;
  usage: string;
  summary: string;
  scheduled: boolean;
  custom: boolean;
  triggerDesc: string;
  enabled?: boolean;
}

function triggerDesc(t: Trigger): string {
  return t.kind === "manual" ? "manual" : t.kind === "cron" ? `cron ${t.expr}` : `every ${Math.round(t.everyMs / 60_000)}m`;
}

/** The available loops as render-friendly rows. Pass the store to merge custom loops + show on/off. */
export function listLoops(store?: LoopStore): LoopInfo[] {
  return effectiveLoops(store).map((l) => ({
    name: l.name,
    usage: l.usage,
    summary: l.summary,
    scheduled: l.trigger.kind !== "manual",
    custom: !isBuiltin(l.name),
    triggerDesc: triggerDesc(l.trigger),
    enabled: store ? (store.isEnabled(l.name) ?? l.enabledByDefault ?? false) : undefined,
  }));
}

type CrudResult = { ok: true; def: LoopDef } | { ok: false; error: string };

export function createLoop(input: LoopInput, store: LoopDefStore): CrudResult {
  const res = validateLoopInput(input, { existingNames: effectiveLoops(store).map((l) => l.name) });
  if ("error" in res) return { ok: false, error: res.error };
  store.saveLoopDef(res.def.name, JSON.stringify(res.def));
  return { ok: true, def: res.def };
}

export function updateLoop(name: string, input: LoopInput, store: LoopDefStore): CrudResult {
  if (isBuiltin(name)) return { ok: false, error: "built-in loops can't be edited" };
  if (!effectiveLoops(store).some((l) => l.name === name)) return { ok: false, error: `no custom loop "${name}"` };
  const existingNames = effectiveLoops(store)
    .map((l) => l.name)
    .filter((n) => n !== name);
  const res = validateLoopInput({ ...input, name }, { existingNames });
  if ("error" in res) return { ok: false, error: res.error };
  store.saveLoopDef(res.def.name, JSON.stringify(res.def));
  return { ok: true, def: res.def };
}

export function deleteLoop(name: string, store: LoopDefStore): { ok: true } | { ok: false; error: string } {
  if (isBuiltin(name)) return { ok: false, error: "built-in loops can't be deleted" };
  store.deleteLoopDef(name);
  return { ok: true };
}

function schedLabel(l: LoopDef, store?: LoopStore): string {
  if (l.trigger.kind === "manual") return "";
  const cadence = l.trigger.kind === "cron" ? l.trigger.expr : `every ${Math.round(l.trigger.everyMs / 60_000)}m`;
  const on = store?.isEnabled(l.name) ?? l.enabledByDefault ?? false;
  return ` [${cadence}: ${on ? "on" : "off"}]`;
}

function formatLoops(store?: LoopStore): string {
  return ["Available loops:", ...effectiveLoops(store).map((l) => `${l.usage} — ${l.summary}${schedLabel(l, store)}`)].join("\n");
}

/** Run a loop end to end, streaming progress and a final outcome line to the channel. */
export async function startLoop(loop: LoopDef, chatId: number, deps: LoopDeps): Promise<LoopOutcome> {
  await deps.reply(chatId, `🔁 ${loop.name}: starting on ${loop.folder}…`);
  const out = await runProjectLoop(
    {
      folder: loop.folder,
      prompt: loop.prompt,
      goal: loop.goal,
      bounds: loop.bounds,
      onProgress: (m) => void deps.reply(chatId, m.length > 220 ? `${m.slice(0, 220)}…` : m),
      shouldStop: deps.shouldStop,
    },
    { run: deps.run, check: deps.check },
  );
  await deps.reply(
    chatId,
    `🔁 ${loop.name}: ${out.met ? "✅ goal met" : `⚠️ ${out.reason}`} after ${out.iterations} iteration(s) — ${out.lastDetail}`,
  );
  return out;
}

/** Parse + dispatch a /loop command. Returns true if it was a /loop (handled), else false. */
export function handleLoop(text: string, chatId: number, deps: LoopDeps): boolean {
  const t = text.trim();
  if (t !== "/loop" && !t.startsWith("/loop ")) return false;
  const args = t.slice("/loop".length).trim();
  if (!args) {
    void deps.reply(chatId, formatLoops(deps.store));
    return true;
  }
  // "<name> on|off" — toggle a schedule.
  const toggle = args.match(/^(.*?)\s+(on|off)$/i);
  if (toggle) {
    const loop = matchLoop(toggle[1], deps.store);
    if (!loop) {
      void deps.reply(chatId, `No loop "${toggle[1]}".\n\n${formatLoops(deps.store)}`);
      return true;
    }
    if (!deps.store) {
      void deps.reply(chatId, "Schedule control is unavailable right now.");
      return true;
    }
    const on = toggle[2].toLowerCase() === "on";
    deps.store.setEnabled(loop.name, on);
    void deps.reply(chatId, `🔁 ${loop.name}: schedule ${on ? "on" : "off"}`);
    return true;
  }
  const loop = matchLoop(args, deps.store);
  if (!loop) {
    void deps.reply(chatId, `No loop "${args}".\n\n${formatLoops(deps.store)}`);
    return true;
  }
  void startLoop(loop, chatId, deps); // background; streams via deps.reply
  return true;
}
