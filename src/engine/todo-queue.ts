// The per-project todo queue (ADR-0008). Every brief the company dispatches becomes a durable todo
// in the ledger. A brief for a FREE project runs now through dispatchToProject; a brief for a BUSY
// project (or one whose queue is non-empty or paused) waits in order. The queue is RELEASED when the
// current dispatch run ends (the SDK-settled end, ADR-0007) — after its result reached the operator
// and the dispatcher — and on every daemon tick, for queues a hold or a restart left waiting.
// A run that ends for a passing reason keeps its todo as `retry` and re-runs it after a backoff; a
// failed todo is never dropped and can be retried (ADR-0027, rules in todo-retry.ts).
// Deterministic: no AI decides anything here.
import { basename } from "node:path";
import type { Cause, Ledger, TodoRow } from "./ledger";
import type { Registry } from "./registry";
import { heldByReserve, type WorkClass } from "./budget";
import { dispatchToProject, resolveProject, DESKS_DIR, planWaitTail, type DispatchDeps, type DispatchOpts, type ReplyMeta, type TodoEnd } from "./dispatch";
import { lastCommitIn, uncommittedIn } from "./dispatch-report";
import { raise } from "./attention";
import { msgRef } from "./trace";
import { todoTitle } from "./todo-title";
import { faults } from "./fault";
import { classifyEnd, nextRetry, retryBrief } from "./todo-retry";
import { awaitHandoff, continuationBrief, handoffInFlight, type HandoffNext } from "./context-policy";
import { awaitCommitFinish, commitFinishInFlight } from "./commit-finish";

import { TODO_RETRY_BACKOFF_MS_DEFAULT, type TodoFailurePolicy } from "../config";

/** The attention kinds the queue raises (spec §8.6) — the briefs test checks each has a template. */
export const DIRTY_KINDS = ["dirty"] as const;

/** Finished todos shown in a single project's `/todo <project>` view. */
const HISTORY_SHOWN = 5;
/** Failed todos shown per project in `/todo` (newest first; all of them stay in the ledger). */
const FAILED_SHOWN = 10;

/** "in 15m" / "in 4h" — when a waiting retry is due. */
function dueIn(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 120 ? `in ${Math.round(m / 60)}h` : `in ${m}m`;
}

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
  /** The retry backoff ladder (ms per retry; its length = the number of automatic retries), read live
   *  so a config reload applies (ADR-0027). Default TODO_RETRY_BACKOFF_MS_DEFAULT. */
  retryBackoffMs?: () => readonly number[];
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
  /** Re-run a todo (ADR-0027): a `failed` one joins the end of the queue with a fresh retry budget; a
   *  `retry` one goes to the head now, without waiting for its backoff. The same row — never a copy. */
  retry(id: number): string;
  /** A decision was answered (ADR-0029): the continuation parked on it goes to the head of its queue
   *  with the answer in its brief. Returns that todo, or undefined when nothing was parked on it. */
  decisionAnswered(decisionId: string, question: string, answer: string): TodoRow | undefined;
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
  const ladder = (): readonly number[] => q.retryBackoffMs?.() ?? TODO_RETRY_BACKOFF_MS_DEFAULT;
  let launcherFn: () => TodoLauncher | undefined = () => undefined;
  let lastSeen: TodoLauncher | undefined;
  const launcher = (): TodoLauncher | undefined => launcherFn() ?? lastSeen;
  /** Orders of todo runs started by THIS process and not yet ended. The one true "its run is still
   *  live" signal: the registry reads the session idle a moment before the run's end reaches the
   *  queue, and a row left `running` by a crash is never in here. */
  const live = new Set<string>();
  /** Answers to a run's decision that arrived while its handoff was still running (order → answers):
   *  folded into the continuation, so the answer is never lost and no second session starts (ADR-0029). */
  const earlyAnswers = new Map<string, string[]>();
  const answerLine = (decisionId: string, question: string, answer: string) =>
    `The operator answered decision #${decisionId.slice(0, 8)} ("${question}"): ${answer}`;
  const takeAnswers = (orderId: string | undefined): string => {
    const a = orderId ? earlyAnswers.get(orderId) : undefined;
    if (!a) return "";
    earlyAnswers.delete(orderId!);
    return `\n\n${a.join("\n")}`;
  };
  /** Folders whose release waits for an in-flight handoff to settle (one waiter each). */
  const awaiting = new Set<string>();
  /** Folders whose release waits for a commit finish in their repository to end (ADR-0037). */
  const awaitingCommit = new Set<string>();
  /** True while a commit finish holds the folder's repository (any worktree): the folder's next todo
   *  waits, and is released the moment the commit finish ends (one waiter per folder). */
  const commitHeld = (folder: string): boolean => {
    if (!commitFinishInFlight(folder)) return false;
    if (!awaitingCommit.has(folder)) {
      awaitingCommit.add(folder);
      void awaitCommitFinish(folder).then(() => {
        awaitingCommit.delete(folder);
        return pumpAll();
      });
    }
    return true;
  };
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

  /** What the queue will do after todo `t` ends with `ok` (and `failure`, ADR-0027) — for the
   *  dispatcher's result. */
  const nextNote = (t: TodoRow, ok: boolean, failure?: string): string | undefined => {
    const folder = t.folder;
    // A transient end with retries left: the todo re-runs by itself — say so, so nobody re-dispatches it.
    const again = !ok && classifyEnd(failure).transient ? nextRetry(t.attempts, ladder(), now()) : undefined;
    const retryLine = again
      ? `[todo] #${t.id} stopped for a passing reason (${failure}); it is kept and re-runs by itself ${dueIn(again.retryAt - now())} (retry ${t.attempts + 1}/${ladder().length}) — do NOT dispatch it again.`
      : undefined;
    const waiting = queued(folder);
    if (waiting.length === 0) return retryLine;
    const join = (line: string) => (retryLine ? `${retryLine}\n${line}` : line);
    if (ledger.todoPaused(folder) || (!ok && !again && q.onFailure() === "pause")) {
      return join(`[todo] queue paused: ${waiting.length} waiting — resume it with the todo tool when ready.`);
    }
    const more = waiting.length - 1;
    return join(`[todo] next: ${tag(waiting[0])} starts now${more ? ` (${more} more queued)` : ""} — no need to dispatch it again.`);
  };

  type LaunchOutcome =
    | { kind: "run"; text: string }
    | { kind: "delivered"; text: string }
    | { kind: "refused"; reason: string; text: string };

  /** Start one todo through dispatchToProject, recording what happened on the row. */
  const launch = async (t: TodoRow, l: TodoLauncher, quiet: boolean): Promise<LaunchOutcome> => {
    let outcome: "run" | "delivered" | undefined;
    let refused = "";
    // A todo that ran before (an automatic retry, or the operator's re-run of a failed one) is told so
    // (ADR-0027); the stored brief never changes.
    const brief = t.startedAt !== undefined ? retryBrief(t, ladder().length) : t.brief;
    const text = await dispatchToProject(t.folder, brief, l.deps, l.replyChat, {
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
              ? { status: "running", orderId, startedAt: now(), retryAt: null }
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
        resultNote: (ok, failure) => nextNote(ledger.todoById(t.id) ?? t, ok, failure),
        onEnd: (end) => finish(end, l),
        onHandoff: ({ orderId, next, note }) => afterHandoff(orderId, next, note),
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
    promoteDue();
    // A handoff is still writing the note (ADR-0029): what runs next may be its continuation, queued at
    // the head when it completes — so wait, and release once it has settled.
    if (handoffInFlight(folder)) {
      if (!awaiting.has(folder)) {
        awaiting.add(folder);
        void awaitHandoff(folder).then(() => {
          awaiting.delete(folder);
          return pumpAll();
        });
      }
      return { waits: "handing off" };
    }
    if (commitHeld(folder)) return { waits: "finishing a commit" };
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
  const finish = async (end: TodoEnd, l: TodoLauncher): Promise<void> => {
    live.delete(end.orderId);
    const t = ledger.todoByOrder(end.orderId);
    if (!t || t.status !== "running") return;
    // Handed off at a safe checkpoint (ADR-0021): the work is not finished. Its continuation goes to
    // the HEAD of the project's queue, so the release below starts it before anything else.
    const cont =
      end.ok && end.continuation
        ? ledger.addTodo({ project: t.project, folder: t.folder, brief: end.continuation + takeAnswers(end.orderId), team: t.team, workClass: t.workClass, createdBy: t.createdBy, cause: t.cause }, now())
        : undefined;
    if (cont) ledger.moveTodo(cont.id, 1);
    // A bad end: a transient one with retries left keeps the todo as `retry`; otherwise `failed`,
    // never dropped (ADR-0027). Only `failed` is a final bad end, so only it applies the policy.
    const cls = end.ok ? undefined : classifyEnd(end.failure);
    const again = cls?.transient ? nextRetry(t.attempts, ladder(), now()) : undefined;
    const failure = end.failure ? { failure: end.failure } : {};
    if (end.ok) {
      ledger.updateTodo(t.id, { status: "done", result: cont ? `${end.summary} → continuing as #${cont.id}` : end.summary, endedAt: now() });
    } else if (again) {
      ledger.updateTodo(t.id, { status: "retry", attempts: t.attempts + 1, retryAt: again.retryAt, result: end.summary, endedAt: now(), ...failure });
      ledger.recordEvent("todo_retry", { folder: t.folder, orderId: end.orderId, data: { project: t.project, id: t.id, attempt: t.attempts + 1, retryAt: again.retryAt, failure: end.failure }, cause: t.cause });
    } else {
      const gaveUp = cls?.transient ? `gave up after ${t.attempts + 1} attempts: ` : "";
      ledger.updateTodo(t.id, { status: "failed", result: `${gaveUp}${end.summary}`, endedAt: now(), retryAt: null, ...failure });
    }
    // A finished run closes the earlier failed/retry todos of its thread and folder (ADR-0027 §6).
    const closed = end.ok && !cont && t.cause ? ledger.closeSupersededTodos(t.cause.threadId, t.folder, t.id, now()) : [];
    if (closed.length) ledger.recordEvent("todo_superseded", { folder: t.folder, orderId: end.orderId, data: { project: t.project, id: t.id, closed }, cause: t.cause });
    refresh(launcher()?.deps ?? l.deps, t.cause);
    if (!end.ok && !again && q.onFailure() === "pause" && queued(t.folder).length > 0) {
      ledger.setTodoPaused(t.folder, `#${t.id} failed`, now());
    }
    const left = cont ? undefined : leftUncommitted(t);
    const head =
      (cont
        ? `${t.project}: #${t.id} handed off at a safe checkpoint, continuing as #${cont.id}`
        : end.ok
          ? `${t.project}: done #${t.id}${closed.length ? ` (also closes ${closed.map((x) => `#${x}`).join(", ")}, finished by this run)` : ""}`
          : again
            ? `${t.project}: #${t.id} stopped (${end.failure}) — retry ${t.attempts + 1}/${ladder().length} ${dueIn(again.retryAt - now())}`
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
            : left || again || closed.length
              ? head // nothing queued, but the work left behind, a pending retry or a closed todo must be said
              : undefined;
    // A todo line (spec §4.3): filed under the todo's cause, so it carries its thread's ref.
    if (line) await (launcher() ?? l).deps.reply((launcher() ?? l).replyChat, line, t.project, undefined, todoLine(t));
  };

  /** Due retries go back to the HEAD of their queue — they were ahead of what was queued after them;
   *  the oldest due ends up first (ADR-0027). Run before any release decision, so a brief that arrives
   *  before the tick never jumps a retry that is already due. */
  const promoteDue = (): void => {
    for (const t of ledger.dueTodoRetries(now()).reverse()) {
      ledger.updateTodo(t.id, { status: "queued", retryAt: null });
      ledger.moveTodo(t.id, 1);
    }
  };

  /** After a handoff at the "task done" boundary (ADR-0029): queue the continuation at the head, park
   *  it on the decision this run raised, or nothing — and return the notice's tail. */
  const afterHandoff = (orderId: string, next: HandoffNext, note: string): string | undefined => {
    const t = ledger.todoByOrder(orderId);
    if (!t) return undefined;
    const answers = takeAnswers(orderId); // answered while the note was being written: continue with it
    if (!answers && next.kind === "idle") return "done, idle";
    if (!answers && next.kind === "plan") return planWaitTail(next.decision);
    const parking = !answers && next.kind === "blocked";
    // A parked continuation may run hours later, after other todos: it carries the note itself, and
    // the pending handoff is claimed so an unrelated todo is not told it "continues earlier work".
    const carried = parking && note.trim() ? `\n\nNeo's handoff note from the finished run:\n--- note ---\n${note.trim()}\n--- end of note ---` : "";
    const cont = ledger.addTodo(
      { project: t.project, folder: t.folder, brief: continuationBrief(t.brief) + carried + answers, team: t.team, workClass: t.workClass, createdBy: t.createdBy, cause: t.cause },
      now(),
    );
    if (!parking) {
      ledger.moveTodo(cont.id, 1);
      ledger.recordEvent("todo_continued", { folder: t.folder, orderId, data: { project: t.project, id: t.id, continuation: cont.id }, cause: t.cause });
      refresh(launcher()?.deps, t.cause);
      return `continuing as #${cont.id}${answers ? " (with your answer)" : ""}`;
    }
    if (next.kind !== "blocked") return undefined; // unreachable: parking implies blocked
    const short = next.decision.id.slice(0, 8);
    ledger.updateTodo(cont.id, { status: "waiting", waitingOn: next.decision.id });
    faults.guard("todo.claimHandoff", () => {
      const pending = ledger.pendingHandoff(t.folder);
      if (pending) ledger.recordContextEvent(t.folder, "resumed", 0, now(), { reason: pending.reason, boundary: "resume", detail: { handoffId: pending.id, parkedAs: cont.id } });
    });
    ledger.recordEvent("todo_waiting", { folder: t.folder, orderId, data: { project: t.project, id: cont.id, decision: next.decision.id }, cause: t.cause });
    refresh(launcher()?.deps, t.cause);
    return `paused: waiting on decision #${short} — ${next.decision.question} (continues as #${cont.id} once answered)`;
  };
  const pumpAll = async (): Promise<void> => {
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
  };

  const describePosition = (t: TodoRow): number => queued(t.folder).findIndex((x) => x.id === t.id) + 1;

  const renderProject = (folder: string, history: boolean): string => {
    const all = ledger.listTodos({ folder, statuses: ["running", "queued"] });
    const name = all[0]?.project ?? ledger.listTodos({ folder, limit: 1 })[0]?.project ?? basename(folder);
    const paused = ledger.todoPaused(folder);
    const lines = [`📋 ${name}${paused ? ` — paused (${paused.reason})` : ""}`];
    const t0 = now();
    for (const t of all) {
      if (t.status === "running") lines.push(`  ▶ #${t.id} running ${Math.max(0, Math.round((t0 - (t.startedAt ?? t0)) / 60_000))}m — ${todoTitle(t.brief)}`);
    }
    all.filter((t) => t.status === "queued").forEach((t, i) => lines.push(`  ${i + 1}. #${t.id} ${todoTitle(t.brief)}`));
    // Parked continuations (ADR-0029): each waits on one decision.
    for (const t of ledger.listTodos({ folder, statuses: ["waiting"] })) {
      lines.push(`  ⏸ #${t.id} waiting on decision #${(t.waitingOn ?? "?").slice(0, 8)} — ${todoTitle(t.brief)}`);
    }
    // Kept work (ADR-0027): waiting retries, then failed todos with how to re-run them.
    for (const t of ledger.listTodos({ folder, statuses: ["retry"] })) {
      lines.push(`  ↻ #${t.id} retry ${t.attempts}/${ladder().length} ${dueIn((t.retryAt ?? t0) - t0)} (${t.failure ?? "stopped"}) — ${todoTitle(t.brief)}`);
    }
    for (const t of ledger.listTodos({ folder, statuses: ["failed"], limit: FAILED_SHOWN })) {
      lines.push(`  ✗ #${t.id} failed — ${todoTitle(t.brief)} (/todo retry ${t.id})`);
    }
    if (history) {
      for (const t of ledger.listTodos({ folder, statuses: ["done", "cancelled"], limit: HISTORY_SHOWN })) {
        lines.push(`  ${t.status === "done" ? "✓" : "–"} #${t.id} ${t.status} — ${todoTitle(t.brief)}`);
      }
    }
    return lines.join("\n");
  };

  return {
    async submit(p, deps, replyChat) {
      lastSeen = { deps, replyChat };
      promoteDue();
      const folder = resolveProject(p.project, deps.workRoot ?? q.dispatchOpts?.root, q.dispatchOpts?.desks ?? DESKS_DIR);
      // Unknown project: dispatch reports it exactly as before, and no todo is created.
      const traced = { cause: p.cause, parentOrderId: p.parentOrderId };
      if (!folder) return dispatchToProject(p.project, p.brief, deps, replyChat, { ...q.dispatchOpts, root: deps.workRoot ?? q.dispatchOpts?.root, workClass: p.workClass, ...traced });
      const project = basename(folder);
      const paused = ledger.todoPaused(folder);
      const mustWait = busy(folder) || queued(folder).length > 0 || !!paused || commitHeld(folder);
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
      promoteDue();
      await pumpAll();
    },

    decisionAnswered(decisionId, question, answer) {
      const parked = ledger.todosWaitingOn(decisionId);
      for (const t of parked.reverse()) {
        const brief = `${t.brief}\n\n${answerLine(decisionId, question, answer)}`;
        ledger.updateTodo(t.id, { status: "queued", waitingOn: null, brief });
        ledger.moveTodo(t.id, 1);
        ledger.recordEvent("todo_resumed", { folder: t.folder, data: { project: t.project, id: t.id, decision: decisionId }, cause: t.cause });
        refresh(launcher()?.deps, t.cause);
      }
      if (parked.length === 0) {
        // Answered while the run's handoff is still writing its note: nothing is parked YET. Hold the
        // answer for that order's continuation instead of letting the caller open a second session.
        const dec = ledger.decisionById(decisionId);
        const t = dec?.orderId ? ledger.todoByOrder(dec.orderId) : undefined;
        if (!t || !handoffInFlight(t.folder)) return undefined;
        const orderId = t.orderId!;
        earlyAnswers.set(orderId, [...(earlyAnswers.get(orderId) ?? []), answerLine(decisionId, question, answer)]);
        // Normally the settled handoff's afterHandoff takes it. If nothing did by the time the handoff
        // settles (a checkpoint handoff), queue the continuation with the answer here — never drop it.
        void awaitHandoff(t.folder).then(() => {
          const left = takeAnswers(orderId);
          if (!left) return;
          const cont = ledger.addTodo(
            { project: t.project, folder: t.folder, brief: continuationBrief(t.brief) + left, team: t.team, workClass: t.workClass, createdBy: t.createdBy, cause: t.cause },
            now(),
          );
          ledger.moveTodo(cont.id, 1);
          refresh(launcher()?.deps, t.cause);
          return pumpAll();
        });
        return t;
      }
      void this.pump();
      return ledger.todoById(parked[parked.length - 1]!.id);
    },

    recover(opts) {
      const readCommit = opts.lastCommit ?? lastCommitIn;
      const cut = ledger.listTodos({ statuses: ["running"] });
      for (const t of cut) {
        const head = readCommit(t.folder);
        const result = `interrupted by an engine restart before it finished${head ? ` — stopped at: folder HEAD now ${head}` : ""}`;
        // A restart is a passing reason (ADR-0027): keep it as `retry` under the same ladder.
        const again = nextRetry(t.attempts, ladder(), opts.now);
        if (again) {
          ledger.updateTodo(t.id, { status: "retry", attempts: t.attempts + 1, retryAt: again.retryAt, endedAt: opts.now, result, failure: "restart" });
        } else {
          ledger.updateTodo(t.id, { status: "failed", endedAt: opts.now, result: `gave up after ${t.attempts + 1} attempts: ${result}`, failure: "restart" });
          if (q.onFailure() === "pause" && queued(t.folder).length > 0) ledger.setTodoPaused(t.folder, `#${t.id} cut short by a restart`, opts.now);
        }
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
      const folders = [...new Set(ledger.listTodos({ statuses: ["running", "queued", "retry", "waiting", "failed"] }).map((t) => t.folder))];
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
      if (t.status !== "queued" && t.status !== "retry" && t.status !== "waiting") return `#${id} is already ${t.status}.`;
      ledger.updateTodo(id, { status: "cancelled", endedAt: now(), result: "cancelled", retryAt: null, waitingOn: null });
      parents.delete(id);
      ledger.recordEvent("todo_cancelled", { folder: t.folder, data: { project: t.project, id }, cause: t.cause });
      refresh(launcher()?.deps, t.cause);
      return `cancelled #${id} for ${t.project}: ${todoTitle(t.brief)}`;
    },

    retry(id) {
      const t = ledger.todoById(id);
      if (!t) return `No todo #${id}.`;
      if (t.status !== "failed" && t.status !== "retry") return `#${id} is ${t.status} — only a failed or waiting retry todo can be retried.`;
      if (t.status === "failed") {
        // The operator's (or the company's) call: a fresh retry budget, at the end of the queue.
        ledger.updateTodo(id, { status: "queued", attempts: 0, retryAt: null });
        ledger.moveTodo(id, Number.MAX_SAFE_INTEGER);
      } else {
        ledger.updateTodo(id, { status: "queued", retryAt: null });
        ledger.moveTodo(id, 1);
      }
      ledger.recordEvent("todo_retried", { folder: t.folder, data: { project: t.project, id, from: t.status }, cause: t.cause });
      refresh(launcher()?.deps, t.cause);
      const position = describePosition(t); // before the pump: it may start the todo at once
      void this.pump();
      return `↻ #${id} re-queued for ${t.project} at position ${position}${t.status === "retry" ? " (now, not after its backoff)" : ""}: ${todoTitle(t.brief)}`;
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
