// The per-project todo queue (ADR-0008). Every brief the company dispatches becomes a durable todo
// in the ledger. A brief for a FREE project runs now through dispatchToProject; a brief for a BUSY
// project (or one whose queue is non-empty or paused) waits in order. The queue is RELEASED when the
// current dispatch run ends (the SDK-settled end, ADR-0007) — after its result reached the operator
// and the dispatcher — and on every daemon tick, for queues a hold or a restart left waiting.
// Deterministic: no AI decides anything here.
import { basename } from "node:path";
import type { Cause, Ledger, TodoRow } from "./ledger";
import type { Registry } from "./registry";
import { heldByReserve, type WorkClass } from "./budget";
import { dispatchToProject, resolveProject, DESKS_DIR, type DispatchDeps, type DispatchOpts, type ReplyMeta } from "./dispatch";
import { lastCommitIn, uncommittedIn } from "./dispatch-report";
import { raise } from "./attention";
import { msgRef } from "./trace";
import { todoTitle } from "./todo-title";
import { faults } from "./fault";

import type { TodoFailurePolicy } from "../config";

/** The attention kinds the queue raises (spec §8.6) — the briefs test checks each has a template. */
export const DIRTY_KINDS = ["dirty"] as const;

/** Finished todos shown in a single project's `/todo <project>` view. */
const HISTORY_SHOWN = 5;

/** The deps + chat a release starts a todo with (the operator channel's own dispatch deps). */
export interface TodoLauncher {
  deps: DispatchDeps;
  replyChat: number;
}

export interface TodoQueueDeps {
  ledger: Ledger;
  registry: Registry;
  /** Read live, so a config reload of `todoOnFailure` applies to the next bad end. */
  onFailure: () => TodoFailurePolicy;
  now?: () => number;
  /** Test seams passed through to dispatchToProject (start, now, …). */
  dispatchOpts?: Partial<DispatchOpts>;
  /** The folder's uncommitted paths, read when a todo ends (spec §8.6). Default: git status. */
  uncommitted?: (folder: string) => string[] | undefined;
}

export interface TodoQueue {
  /** Hand a brief to a project: run now when it is free, else queue it. Returns the text for the caller.
   *  `cause` (ADR-0015) is the operator message the brief answers — the todo, and the dispatch that
   *  runs it, are filed under it; `parentOrderId` is the company order that made it; `planId` the plan
   *  an Execute tap queued it for (ADR-0019). */
  submit(
    p: { project: string; brief: string; team?: "frontend-backend"; workClass: WorkClass; cause?: Cause; parentOrderId?: string; planId?: number },
    deps: DispatchDeps,
    replyChat: number,
  ): Promise<string>;
  /** Release every free, unpaused project's next todo (the daemon tick; also after resume). */
  pump(): Promise<void>;
  /** Boot: a todo still `running` was cut short by the restart — fail it with its stop point. */
  recover(opts: { now: number; lastCommit?: (folder: string) => string | undefined }): number;
  /** Text view: all projects with work (no arg), or one project with its recent history. */
  list(project?: string): string;
  cancel(id: number): string;
  up(id: number): string;
  move(id: number, position: number): string;
  pause(project: string): string;
  resume(project: string): string;
  /** Register how releases outside a dispatch (tick, resume) reach the operator channel. */
  setLauncher(fn: () => TodoLauncher | undefined): void;
  launcher(): TodoLauncher | undefined;
  /** TEST-ONLY seam: how many todos still hold an in-memory parent order link (it must not leak). */
  _pendingParents(): number;
}

/** The title rule lives in todo-title.ts (the ledger migrations use it too); re-exported for callers. */
export { todoTitle };

/** True when the project's session cannot take a brief now: preparing (running, no live handle yet),
 *  closing, in a turn, or holding a follow-up. Mirrors dispatch's reuse guard. */
export function projectBusy(registry: Registry, folder: string): boolean {
  const s = registry.findByFolder(folder);
  if (!s || s.status !== "running") return false;
  const c = registry.getControl(s.id);
  if (!c) return true;
  return c.closed?.() === true || c.active?.() === true || (c.queued?.() ?? 0) > 0;
}

/** A dispatch hold that would refuse a release right now (checked first, so a held queue writes no
 *  refusal event on every tick). */
function holdReason(deps: DispatchDeps, workClass: WorkClass, now: number): string | undefined {
  if (deps.lifecycle?.draining()) return "engine reloading";
  if (deps.cooldown?.activeAt(now)) return "API cooldown";
  if (heldByReserve(workClass, deps.meter, now)) return "interactive reserve";
  return undefined;
}

export function createTodoQueue(q: TodoQueueDeps): TodoQueue {
  const { ledger, registry } = q;
  const now = q.now ?? q.dispatchOpts?.now ?? (() => Date.now()); // one clock with dispatch
  let launcherFn: () => TodoLauncher | undefined = () => undefined;
  let lastSeen: TodoLauncher | undefined;
  const launcher = (): TodoLauncher | undefined => launcherFn() ?? lastSeen;
  /** Orders of todo runs started by THIS process and not yet ended. The one true "its run is still
   *  live" signal: the registry reads the session idle a moment before the run's end reaches the
   *  queue, and a row left `running` by a crash is never in here. */
  const live = new Set<string>();
  /** Todo id → the company order that submitted it, for the sub-order's `parent_order_id`. In memory:
   *  a todo released after a restart has no parent (its cause is durable on the row). */
  const parents = new Map<number, string>();
  /** Re-derive a todo's thread state after its status changed; best-effort (ADR-0010). */
  const refresh = (deps: DispatchDeps | undefined, cause: Cause | undefined): void => {
    const trace = deps?.trace;
    if (trace && cause) faults.guard("todo.refreshThread", () => trace.refreshThread(cause.threadId), { threadId: cause.threadId });
  };

  const queued = (folder: string) => ledger.listTodos({ folder, statuses: ["queued"] });
  const runningTodo = (folder: string) => ledger.listTodos({ folder, statuses: ["running"], limit: 1 })[0];
  const busy = (folder: string) => !!runningTodo(folder) || projectBusy(registry, folder);
  const tag = (t: TodoRow) => `#${t.id} '${todoTitle(t.brief)}'`;
  /** A line about a todo's run: a result-like line under the todo's own cause (its thread's ref). */
  const todoLine = (t: TodoRow): ReplyMeta => ({ kind: "result", folder: t.folder, ...(t.cause ? { cause: t.cause } : {}) });

  const findFolder = (project: string, deps?: DispatchDeps): string | undefined => {
    const known = ledger.listTodos({ limit: 200 }).find((t) => t.project === project || t.folder === project);
    if (known) return known.folder;
    return resolveProject(project, deps?.workRoot ?? launcher()?.deps.workRoot ?? q.dispatchOpts?.root, q.dispatchOpts?.desks ?? DESKS_DIR);
  };

  /** What the queue will do after a todo of `folder` ends with `ok` — for the dispatcher's result. */
  const nextNote = (folder: string, ok: boolean): string | undefined => {
    const waiting = queued(folder);
    if (waiting.length === 0) return undefined;
    if (ledger.todoPaused(folder) || (!ok && q.onFailure() === "pause")) {
      return `[todo] queue paused: ${waiting.length} waiting — resume it with the todo tool when ready.`;
    }
    const more = waiting.length - 1;
    return `[todo] next: ${tag(waiting[0])} starts now${more ? ` (${more} more queued)` : ""} — no need to dispatch it again.`;
  };

  type LaunchOutcome =
    | { kind: "run"; text: string }
    | { kind: "delivered"; text: string }
    | { kind: "refused"; reason: string; text: string };

  /** Start one todo through dispatchToProject, recording what happened on the row. */
  const launch = async (t: TodoRow, l: TodoLauncher, quiet: boolean): Promise<LaunchOutcome> => {
    let outcome: "run" | "delivered" | undefined;
    let refused = "";
    const text = await dispatchToProject(t.folder, t.brief, l.deps, l.replyChat, {
      ...q.dispatchOpts,
      root: l.deps.workRoot ?? q.dispatchOpts?.root,
      team: t.team,
      workClass: t.workClass,
      cause: t.cause,
      parentOrderId: parents.get(t.id),
      hooks: {
        quietStart: quiet,
        onLaunched: (orderId, mode) => {
          outcome = mode;
          if (mode === "run") live.add(orderId);
          ledger.updateTodo(
            t.id,
            mode === "run"
              ? { status: "running", orderId, startedAt: now() }
              : {
                  status: "done",
                  orderId,
                  startedAt: now(),
                  endedAt: now(),
                  result: "delivered into the operator's open session — its result streams to the operator only",
                },
          );
        },
        onRefused: (reason) => void (refused = reason),
        resultNote: (ok) => nextNote(t.folder, ok),
        onEnd: (end) => finish(end, l),
      },
    });
    parents.delete(t.id);
    const o = outcome as "run" | "delivered" | undefined; // set inside the hook, so TS cannot see it
    if (o === "run") return { kind: "run", text };
    if (o === "delivered") return { kind: "delivered", text };
    return { kind: "refused", reason: refused || "unknown", text };
  };

  /** Release one folder: start its next todo if it is free, unpaused and not held. Returns the
   *  todo it started, or why it did not. Fails a todo whose folder vanished and tries the next. */
  const release = async (folder: string, l: TodoLauncher, quiet: boolean): Promise<{ started?: TodoRow; delivered?: TodoRow; waits?: string }> => {
    for (;;) {
      if (ledger.todoPaused(folder)) return { waits: "paused" };
      if (busy(folder)) return { waits: "busy" };
      const next = queued(folder)[0];
      if (!next) return {};
      const hold = holdReason(l.deps, next.workClass, now());
      if (hold) return { waits: hold };
      const r = await launch(next, l, quiet);
      if (r.kind === "run") return { started: ledger.todoById(next.id) };
      if (r.kind === "delivered") return { delivered: ledger.todoById(next.id) };
      if (r.reason === "not_found") {
        ledger.updateTodo(next.id, { status: "failed", endedAt: now(), result: "the project folder was not found at release" });
        parents.delete(next.id);
        refresh(l.deps, next.cause);
        continue;
      }
      return { waits: r.reason }; // busy/closing/held after all — the next tick retries
    }
  };

  /** Work a finished todo left uncommitted (spec §8.6): a high `dirty` item for the git producer to
   *  resolve once it is committed, and the count for the todo's line. A handoff is not an end: its
   *  continuation goes on with the same files. Contained: a git or ledger fault costs the line its
   *  suffix, never the queue. */
  const leftUncommitted = (t: TodoRow): number | undefined =>
    faults.guard("todo.uncommitted", () => {
      const files = (q.uncommitted ?? uncommittedIn)(t.folder);
      if (!files?.length) return undefined;
      const shown = files.slice(0, 10).join(", ") + (files.length > 10 ? ` (+${files.length - 10} more)` : "");
      raise(ledger, {
        project: basename(t.folder), folder: t.folder, source: "git", kind: DIRTY_KINDS[0], key: t.folder, severity: "high",
        title: `${files.length} uncommitted file${files.length === 1 ? "" : "s"} after todo #${t.id}`,
        detail: `${t.cause ? `thread ${msgRef(t.cause.threadId)} · ` : ""}files: ${shown}`,
      }, now());
      return files.length;
    }, { folder: t.folder, todo: t.id });

  /** A dispatch run of a todo ended: record it, apply the failure policy, release the next one,
   *  and send the operator ONE line about the transition (none when the queue is empty). */
  const finish = async (end: { orderId: string; ok: boolean; summary: string; continuation?: string }, l: TodoLauncher): Promise<void> => {
    live.delete(end.orderId);
    const t = ledger.todoByOrder(end.orderId);
    if (!t || t.status !== "running") return;
    // Handed off at a safe checkpoint (ADR-0021): the work is not finished. Its continuation goes to
    // the HEAD of the project's queue, so the release below starts it before anything else.
    const cont =
      end.ok && end.continuation
        ? ledger.addTodo({ project: t.project, folder: t.folder, brief: end.continuation, team: t.team, workClass: t.workClass, createdBy: t.createdBy, cause: t.cause }, now())
        : undefined;
    if (cont) ledger.moveTodo(cont.id, 1);
    ledger.updateTodo(t.id, { status: end.ok ? "done" : "failed", result: cont ? `${end.summary} → continuing as #${cont.id}` : end.summary, endedAt: now() });
    refresh(launcher()?.deps ?? l.deps, t.cause);
    if (!end.ok && q.onFailure() === "pause" && queued(t.folder).length > 0) {
      ledger.setTodoPaused(t.folder, `#${t.id} failed`, now());
    }
    const left = cont ? undefined : leftUncommitted(t);
    const head =
      (cont
        ? `${t.project}: #${t.id} handed off at a safe checkpoint, continuing as #${cont.id}`
        : end.ok
          ? `${t.project}: done #${t.id}`
          : `${t.project}: #${t.id} failed`) + (left ? ` — left ${left} uncommitted file${left === 1 ? "" : "s"}` : "");
    const r = await release(t.folder, launcher() ?? l, true);
    const line = r.started
      ? `${head}, starting ${tag(r.started)}`
      : r.delivered
        ? `${head}, delivered ${tag(r.delivered)} into the open session`
        : r.waits === "paused"
          ? `${head} — queue paused, ${queued(t.folder).length} waiting (/todo resume ${t.project})`
          : r.waits && queued(t.folder).length > 0
            ? `${head}; next waits (${r.waits})`
            : left
              ? head // nothing queued, but the work left behind must be said
              : undefined;
    // A todo line (spec §4.3): filed under the todo's cause, so it carries its thread's ref.
    if (line) await (launcher() ?? l).deps.reply((launcher() ?? l).replyChat, line, t.project, undefined, todoLine(t));
  };

  const describePosition = (t: TodoRow): number => queued(t.folder).findIndex((x) => x.id === t.id) + 1;

  const renderProject = (folder: string, history: boolean): string => {
    const all = ledger.listTodos({ folder, statuses: ["running", "queued"] });
    const name = all[0]?.project ?? basename(folder);
    const paused = ledger.todoPaused(folder);
    const lines = [`📋 ${name}${paused ? ` — paused (${paused.reason})` : ""}`];
    const t0 = now();
    for (const t of all) {
      if (t.status === "running") lines.push(`  ▶ #${t.id} running ${Math.max(0, Math.round((t0 - (t.startedAt ?? t0)) / 60_000))}m — ${todoTitle(t.brief)}`);
    }
    all.filter((t) => t.status === "queued").forEach((t, i) => lines.push(`  ${i + 1}. #${t.id} ${todoTitle(t.brief)}`));
    if (history) {
      for (const t of ledger.listTodos({ folder, statuses: ["done", "failed", "cancelled"], limit: HISTORY_SHOWN })) {
        const icon = t.status === "done" ? "✓" : t.status === "failed" ? "✗" : "–";
        lines.push(`  ${icon} #${t.id} ${t.status} — ${todoTitle(t.brief)}`);
      }
    }
    return lines.join("\n");
  };

  return {
    async submit(p, deps, replyChat) {
      lastSeen = { deps, replyChat };
      const folder = resolveProject(p.project, deps.workRoot ?? q.dispatchOpts?.root, q.dispatchOpts?.desks ?? DESKS_DIR);
      // Unknown project: dispatch reports it exactly as before, and no todo is created.
      const traced = { cause: p.cause, parentOrderId: p.parentOrderId };
      if (!folder) return dispatchToProject(p.project, p.brief, deps, replyChat, { ...q.dispatchOpts, root: deps.workRoot ?? q.dispatchOpts?.root, workClass: p.workClass, ...traced });
      const project = basename(folder);
      const paused = ledger.todoPaused(folder);
      const mustWait = busy(folder) || queued(folder).length > 0 || !!paused;
      // A free project under a hold (reload, cooldown, reserve) is refused exactly as before, by
      // dispatch itself, and no todo is created — the queue never turns a refusal into a promise.
      if (!mustWait && holdReason(deps, p.workClass, now())) {
        return dispatchToProject(folder, p.brief, deps, replyChat, { ...q.dispatchOpts, root: deps.workRoot ?? q.dispatchOpts?.root, workClass: p.workClass, ...traced });
      }
      const t = ledger.addTodo(
        { project, folder, brief: p.brief, team: p.team, workClass: p.workClass, createdBy: p.workClass === "interactive" ? "operator" : "company", cause: p.cause, planId: p.planId },
        now(),
      );
      if (p.parentOrderId) parents.set(t.id, p.parentOrderId);
      refresh(deps, p.cause); // a queued todo is the thread's open work
      if (mustWait) {
        const position = describePosition(t);
        ledger.recordEvent("todo_queued", { folder, data: { project, id: t.id, position, paused: !!paused }, cause: p.cause });
        await deps.reply(replyChat, `→ queued #${t.id} for ${project} (position ${position}): ${todoTitle(p.brief)}`, project, undefined, {
          kind: "ack",
          folder,
          ...(p.cause ? { cause: p.cause } : {}),
        });
        return (
          `queued as #${t.id} for ${project}, position ${position}` +
          (paused
            ? ` — its queue is PAUSED (${paused.reason}); it starts after the queue is resumed.`
            : ` — ${project} is busy, so this brief waits and starts by itself when the work ahead of it is done. `) +
          `Do NOT forward it again; you get its result like any dispatch. Tell the operator its number and position.`
        );
      }
      const r = await launch(t, { deps, replyChat }, false);
      if (r.kind === "refused") {
        // Held (cooldown, reserve, reload): refused exactly as before — this brief is not kept.
        ledger.updateTodo(t.id, { status: "cancelled", endedAt: now(), result: `refused: ${r.reason}` });
        refresh(deps, p.cause);
        return r.text;
      }
      return `${r.text} (todo #${t.id})`;
    },

    async pump() {
      const l = launcher();
      if (!l) return;
      for (const folder of ledger.queuedTodoFolders()) {
        try {
          const r = await release(folder, l, true);
          const t = r.started ?? r.delivered;
          if (t) await l.deps.reply(l.replyChat, `${t.project}: starting ${tag(t)} (from the queue)`, t.project, undefined, todoLine(t));
        } catch {
          // one project's release must never stop the others
        }
      }
    },

    recover(opts) {
      const readCommit = opts.lastCommit ?? lastCommitIn;
      const cut = ledger.listTodos({ statuses: ["running"] });
      for (const t of cut) {
        const head = readCommit(t.folder);
        ledger.updateTodo(t.id, {
          status: "failed",
          endedAt: opts.now,
          result: `interrupted by an engine restart before it finished${head ? ` — stopped at: folder HEAD now ${head}` : ""}`,
        });
        if (q.onFailure() === "pause" && queued(t.folder).length > 0) ledger.setTodoPaused(t.folder, `#${t.id} cut short by a restart`, opts.now);
        ledger.recordEvent("todo_interrupted", { folder: t.folder, orderId: t.orderId, data: { project: t.project, id: t.id }, cause: t.cause });
        refresh(launcher()?.deps, t.cause);
      }
      return cut.length;
    },

    list(project) {
      if (project) {
        const folder = findFolder(project);
        if (!folder) return `No project named "${project}".`;
        if (ledger.listTodos({ folder, limit: 1 }).length === 0 && !ledger.todoPaused(folder)) return `${project}: the todo queue is empty.`;
        return renderProject(folder, true);
      }
      const folders = [...new Set(ledger.listTodos({ statuses: ["running", "queued"] }).map((t) => t.folder))];
      if (folders.length === 0) return "No todos — every project queue is empty.";
      return folders.map((f) => renderProject(f, false)).join("\n\n");
    },

    cancel(id) {
      const t = ledger.todoById(id);
      if (!t) return `No todo #${id}.`;
      if (t.status === "running") {
        // A running todo is stopped with /kill. Only a stale one (no live run, project not busy) is
        // cleared here — and clearing it frees the project, so release the next todo now.
        if ((t.orderId && live.has(t.orderId)) || projectBusy(registry, t.folder)) {
          return `#${id} is running — stop it with /kill ${t.project}; cancel only removes queued todos.`;
        }
        ledger.updateTodo(id, { status: "cancelled", endedAt: now(), result: "cleared: no live run" });
        parents.delete(id);
        refresh(launcher()?.deps, t.cause);
        void this.pump();
        return `cancelled #${id} (it was marked running but ${t.project} has no live run).`;
      }
      if (t.status !== "queued") return `#${id} is already ${t.status}.`;
      ledger.updateTodo(id, { status: "cancelled", endedAt: now(), result: "cancelled" });
      parents.delete(id);
      ledger.recordEvent("todo_cancelled", { folder: t.folder, data: { project: t.project, id }, cause: t.cause });
      refresh(launcher()?.deps, t.cause);
      return `cancelled #${id} for ${t.project}: ${todoTitle(t.brief)}`;
    },

    up(id) {
      const t = ledger.todoById(id);
      if (!t || t.status !== "queued") return t ? `#${id} is ${t.status}, not queued.` : `No todo #${id}.`;
      return this.move(id, Math.max(1, describePosition(t) - 1));
    },

    move(id, position) {
      const t = ledger.todoById(id);
      if (!t || t.status !== "queued") return t ? `#${id} is ${t.status}, not queued.` : `No todo #${id}.`;
      ledger.moveTodo(id, position);
      return `#${id} is now position ${describePosition(t)} for ${t.project}.`;
    },

    pause(project) {
      const folder = findFolder(project);
      if (!folder) return `No project named "${project}".`;
      ledger.setTodoPaused(folder, "paused by request", now());
      return `⏸ ${basename(folder)}: queue paused — queued todos wait, new briefs join the end. Resume with /todo resume ${basename(folder)}.`;
    },

    resume(project) {
      const folder = findFolder(project);
      if (!folder) return `No project named "${project}".`;
      ledger.setTodoPaused(folder, null);
      void this.pump();
      const n = queued(folder).length;
      return `▶ ${basename(folder)}: queue resumed${n ? ` — ${n} queued, the next starts when the project is free` : " (nothing queued)"}.`;
    },

    setLauncher(fn) {
      launcherFn = fn;
    },
    launcher,
    _pendingParents: () => parents.size,
  };
}
