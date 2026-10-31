/** Plan watch (ADR-0036): a running worker that writes a BIG plan is held at it until the operator's
 *  Approve & build. The watch follows the run's own tool calls: when a Write or Edit to a plan path
 *  succeeds, the plan is registered and its card sent at once (`notePlanWritten`). A plan with gate
 *  `approval` that is not approved yet holds the worker: the governor hook's steer (ADR-0021's seam)
 *  denies every tool call except reads, Neo's own tools and edits to plan files, and tells it to
 *  STOP. The hold lifts by itself once the plan is no longer awaiting (approved, dropped, revised
 *  into a small plan). Deterministic: file, ledger and config only.
 *  Order sizes (ADR-0072): `mayHold` false (a quick run) registers and sends a plan but never holds;
 *  `plans()` and `approvedHeld()` tell the size guard whether a plan waits and when plan first ends. */
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { PlanRow } from "./ledger";
import { classifyPlan } from "./plan-gate";
import { notePlanWritten, planState, type PlanDeps, type PlanRun } from "./plans";
import { faults } from "./fault";

/** Tools that write a file, and the input field naming it. */
export const WRITE_TOOLS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/** Tools that only read: a held worker may still look around (and tidy its todo list). */
export const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead", "ListMcpResources", "ReadMcpResource", "TodoWrite", "WebSearch"]);

export interface PlanWatch {
  onToolUse(id: string | undefined, tool: string, input: unknown): void;
  onToolResult(id: string | undefined, isError: boolean): void;
  /** The STOP reason while the worker is held, else undefined (no opinion). */
  steer(tool: string, input: unknown): string | undefined;
  /** The path of the plan the worker is held at, else undefined (ADR-0052: dispatch reads it). */
  held(): string | undefined;
  /** Settles when every card this watch started posting has landed (or failed). */
  settled(): Promise<void>;
  /** The plan ids this watch registered, in the order first seen. */
  plans(): number[];
  /** A plan this watch held is now approved, executing or done (ADR-0072: plan first ends). */
  approvedHeld(): boolean;
}

export function createPlanWatch(
  deps: PlanDeps,
  /** The run as it is now (its cause moves with each turn). */
  run: () => PlanRun,
  opts: { onHold?: (plan: PlanRow) => void; now?: () => number; mayHold?: () => boolean } = {},
): PlanWatch {
  const now = opts.now ?? Date.now;
  const pending = new Map<string, string>(); // tool-use id -> plan path (relative to the folder)
  const inFlight = new Set<Promise<unknown>>();
  let held: number | undefined; // the plan id the worker is held on
  const registered: number[] = []; // every plan id this watch registered
  const everHeld = new Set<number>(); // every plan id this watch held

  /** `file` as a plan path relative to the run's folder, else undefined. */
  const planPath = (file: unknown): string | undefined => {
    if (typeof file !== "string" || !file) return undefined;
    const folder = run().folder;
    const rel = relative(folder, resolve(folder, file));
    if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return undefined;
    return deps.cfg.paths.some((g) => new Bun.Glob(g).match(rel)) ? rel : undefined;
  };

  const writtenPath = (tool: string, input: unknown): string | undefined => {
    const field = WRITE_TOOLS[tool];
    return field && input && typeof input === "object" ? planPath((input as Record<string, unknown>)[field]) : undefined;
  };

  /** Still waiting for the operator: sent or unsent, gate `approval`. */
  const awaiting = (p: PlanRow): boolean => p.gate === "approval" && (planState(p) === "awaiting" || p.status === "draft");

  const written = (path: string): void => {
    const noted = notePlanWritten(deps, run(), path);
    if (!noted) return;
    let plan = noted.plan;
    if (!registered.includes(plan.id)) registered.push(plan.id);
    // A hold needs a card the operator can act on: if the post did not land, the worker is let go
    // (the run end sends the card later; Approve & build then queues the build).
    const track = noted.sent
      .then((landed) => {
        if (landed || held !== plan.id) return;
        held = undefined;
        const row = deps.ledger.planById(plan.id);
        if (row?.heldAt !== undefined) deps.ledger.upsertPlan({ ...row, heldAt: undefined });
        deps.ledger.recordEvent("plan_hold_released", { folder: plan.folder, data: { planId: plan.id, path: plan.path, reason: "card not posted" } });
      })
      .finally(() => inFlight.delete(track));
    inFlight.add(track);
    if (awaiting(plan) && (opts.mayHold?.() ?? true)) {
      if (plan.heldAt === undefined) plan = deps.ledger.upsertPlan({ ...plan, heldAt: now() });
      held = plan.id;
      everHeld.add(plan.id);
      deps.ledger.recordEvent("plan_held", { folder: plan.folder, orderId: run().orderId, data: { project: plan.project, planId: plan.id, path: plan.path } });
      faults.guard("planWatch.onHold", () => opts.onHold?.(plan));
    } else if (held === plan.id) {
      held = undefined;
    }
  };

  /** The plan the worker is held at, read fresh: the hold lifts once the plan no longer awaits. */
  const holding = (): PlanRow | undefined => {
    if (held === undefined) return undefined;
    const plan = deps.ledger.planById(held);
    if (plan && awaiting(plan)) return plan;
    held = undefined;
    return undefined;
  };

  return {
    onToolUse(id, tool, input) {
      const path = writtenPath(tool, input);
      if (path && id) pending.set(id, path);
    },
    onToolResult(id, isError) {
      const path = id ? pending.get(id) : undefined;
      if (!id || path === undefined) return;
      pending.delete(id);
      if (!isError) faults.guard("planWatch.written", () => written(path));
    },
    steer(tool, input) {
      // Never throws: a throw here would also skip the context checkpoint's steer for this call.
      return faults.guard("planWatch.steer", () => {
        const plan = holding();
        if (!plan) return undefined;
        if (READ_TOOLS.has(tool) || tool.startsWith("mcp__neo__") || writtenPath(tool, input)) return undefined;
        return stopReason(deps, plan);
      });
    },
    held() {
      return faults.guard("planWatch.held", () => holding()?.path);
    },
    async settled() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
    plans() {
      return [...registered];
    },
    approvedHeld() {
      return faults.guard("planWatch.approvedHeld", () =>
        [...everHeld].some((id) => {
          const s = deps.ledger.planById(id)?.status;
          return s === "approved" || s === "executing" || s === "done";
        }),
      ) ?? false;
    },
  };
}

/** What a held worker is told on every denied call. */
function stopReason(deps: PlanDeps, plan: PlanRow): string {
  let why = "";
  try {
    why = classifyPlan(readFileSync(join(plan.folder, plan.path), "utf8"), deps.cfg).reasons.join("; ");
  } catch {
    why = "";
  }
  return (
    `STOP — ${plan.path} is a big plan${why ? ` (${why})` : ""}: it needs the operator's approval before any implementation. ` +
    "Its card is with the operator now. Do not build or change code. End your turn now with a one-line summary of the plan. " +
    "Approve & build resumes you to build it; Changes sends you their notes to revise the plan."
  );
}
