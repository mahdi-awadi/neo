// Engine faults (ADR-0010): one error must never take the engine down. A fault is an error no unit's
// own handling dealt with — a throw in a heartbeat step, a promise nobody awaited, an uncaught
// exception. `report` never throws; it logs one line with the stack and context, records an
// `engine_fault` event, alerts the operator (deduplicated by signature, capped per hour), and queues
// it for the company (Neo) to investigate. `guard` / `contain` are the per-unit boundaries.
//
// `faults` is module-level, like an error tracker: the daemon configures it once (`configureFaults`);
// until then (and in tests that do not care) it logs to stderr only.

export interface FaultContext {
  project?: string;
  orderId?: string;
  folder?: string;
  [k: string]: unknown;
}

export interface FaultCfg {
  /** A fault with the same signature inside this window is counted, not re-sent. */
  dedupeMs: number;
  /** Distinct fault alerts per rolling hour; more are logged and recorded only. */
  maxAlertsPerHour: number;
  /** Queue each (deduplicated) fault for the company session to investigate. */
  companyHandoff: boolean;
}

/** Where a fault goes. Every sink is optional except the log, and a throwing sink is ignored. */
export interface FaultSink {
  log(line: string): void;
  record?(data: Record<string, unknown>): void;
  alert?(text: string): void;
  toCompany?(text: string): void;
}

export interface FaultReporter {
  report(component: string, err: unknown, ctx?: FaultContext): void;
  /** Run `fn`; a throw is reported and `undefined` returned. */
  guard<T>(component: string, fn: () => T, ctx?: FaultContext): T | undefined;
  /** A promise nobody awaits (or a function that starts one): a rejection — or a synchronous throw
   *  before the promise exists — is reported instead of reaching the process. */
  contain(component: string, work: Promise<unknown> | (() => Promise<unknown> | unknown), ctx?: FaultContext): void;
}

const HOUR = 60 * 60_000;
/** Lines of stack kept in an alert / company note (the log keeps all of it). */
const STACK_LINES = 6;
/** Signatures remembered for deduplication; the oldest is dropped past this (bounded memory). */
const MAX_SIGNATURES = 500;

function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message || err.name, stack: err.stack };
  if (typeof err === "string") return { message: err };
  try {
    return { message: JSON.stringify(err) ?? String(err) };
  } catch {
    return { message: String(err) };
  }
}

const ctxText = (ctx: FaultContext) =>
  Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k === "orderId" ? "order" : k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");

export function createFaultReporter(sink: FaultSink, cfg: FaultCfg, now: () => number = Date.now): FaultReporter {
  /** signature → when it was last sent, and how many times it was suppressed since. */
  const seen = new Map<string, { sentAt: number; suppressed: number }>();
  let alertTimes: number[] = [];
  const safe = (fn: (() => void) | undefined) => {
    try {
      fn?.();
    } catch {
      // a sink that fails must never turn a reported fault into a new one
    }
  };

  const report: FaultReporter["report"] = (component, err, ctx = {}) => {
    try {
      const { message, stack } = describe(err);
      const where = ctxText(ctx);
      safe(() => sink.log(`[fault] ${component}${where ? ` ${where}` : ""}: ${message}${stack ? `\n${stack}` : ""}`));
      safe(() => sink.record?.({ component, message, stack, ...ctx }));

      const t = now();
      const sig = `${component}|${message.split("\n")[0].slice(0, 200)}`;
      const prev = seen.get(sig);
      if (prev && t - prev.sentAt < cfg.dedupeMs) {
        prev.suppressed++;
        return;
      }
      const repeats = prev?.suppressed ?? 0;
      seen.delete(sig); // re-insert: Map order = recency, so the oldest is dropped first
      seen.set(sig, { sentAt: t, suppressed: 0 });
      if (seen.size > MAX_SIGNATURES) seen.delete(seen.keys().next().value as string);

      const shortStack = stack?.split("\n").slice(1, STACK_LINES + 1).join("\n");
      const again = repeats ? ` (and ${repeats} more since the last report)` : "";
      alertTimes = alertTimes.filter((a) => t - a < HOUR);
      if (alertTimes.length < cfg.maxAlertsPerHour) {
        alertTimes.push(t);
        safe(() => sink.alert?.(`⚠️ engine fault in ${component}${where ? ` (${where})` : ""}: ${message}${again} — the engine keeps running.`));
      }
      if (cfg.companyHandoff) {
        safe(() =>
          sink.toCompany?.(
            `🛠 Engine fault in ${component}${where ? ` (${where})` : ""}${again}: ${message}\n` +
              (shortStack ? `${shortStack}\n` : "") +
              "Investigate the root cause in Neo's own code (/home/neo): the full stack is in the daemon log and the " +
              "`engine_fault` ledger events. If it is a real bug, dispatch a fix on a branch with a failing test first. " +
              "Do not restart the daemon — the operator decides that.",
          ),
        );
      }
    } catch {
      // report itself must never throw
    }
  };

  return {
    report,
    guard(component, fn, ctx) {
      try {
        return fn();
      } catch (e) {
        report(component, e, ctx);
        return undefined;
      }
    },
    contain(component, work, ctx) {
      try {
        const p = typeof work === "function" ? work() : work;
        if (p && typeof (p as Promise<unknown>).then === "function") {
          (p as Promise<unknown>).then(undefined, (e) => report(component, e, ctx));
        }
      } catch (e) {
        report(component, e, ctx);
      }
    },
  };
}

/** Report what nobody caught and keep running (ADR-0010). Only an unrecoverable state exits — and
 *  that exit is explicit at its own site, never here. */
export function installSafetyNet(proc: { on(event: string, fn: (...a: any[]) => void): unknown }, r: FaultReporter = faults): void {
  proc.on("unhandledRejection", (reason: unknown) => r.report("process.unhandledRejection", reason));
  proc.on("uncaughtException", (err: unknown) => r.report("process.uncaughtException", err));
}

const STDERR_ONLY: FaultReporter = createFaultReporter(
  { log: (l) => console.error(l) },
  { dedupeMs: 0, maxAlertsPerHour: 0, companyHandoff: false },
);
let current: FaultReporter = STDERR_ONLY;

/** Set the engine-wide reporter (the daemon, once at startup). */
export function configureFaults(r: FaultReporter): void {
  current = r;
}

/** The engine-wide reporter. Delegates at call time, so modules can import it before configuration. */
export const faults: FaultReporter = {
  report: (c, e, ctx) => current.report(c, e, ctx),
  guard: (c, fn, ctx) => current.guard(c, fn, ctx),
  contain: (c, w, ctx) => current.contain(c, w, ctx),
};
