// Web operator channel: a thin adapter that drives the SAME engine pipeline as Telegram
// (handleMessage, source "neo" -> Agent SDK on the subscription), but renders streamed
// worker output + escalations as events an HTTP/SSE layer can fan out, and resolves
// Allow/Deny approvals out-of-band (the web equivalent of Telegram's inline buttons).
// All logic lives here (tested); frontends/web.ts is just Bun.serve glue over it.
import { basename } from "node:path";
import { handleMessage, type PipelineDeps } from "./pipeline";
import { sharedCodebaseMemoryIndexer } from "./codebase-memory";
import {
  handleCommand,
  selectProject as engineSelectProject,
  killProject as engineKillProject,
  type SelectableProject,
  type CommandDeps,
} from "./commands";
import {
  handleLoop,
  listLoops,
  matchLoop,
  launchLoop,
  createLoop as defCreateLoop,
  updateLoop as defUpdateLoop,
  deleteLoop as defDeleteLoop,
  type LoopInfo,
} from "./loops";
import type { LoopInput } from "./loop-validate";
import { dashboardSnapshot, type DashState } from "./dashboard";
import { mdToHtml, snippetHtml } from "./format";
import { styleLine } from "./priority";
import type { UsageMeter } from "./usage";
import { knownIds, type LineIds, type OperatorBus } from "./operator-bus";
import { setWorkerSdk, type WorkerSdkState } from "./sdk-choice";
import type { Cause, ThreadChange } from "./trace";
import { faults } from "./fault";
import { applyPlanAction, planActions, planDepsFrom, type PlanAction } from "./plans";
import { routeThreadMessage } from "./reply-routing";
import { PAGE_MAX, type MessageRow, type PlanRow, type SearchHit, type ThreadArtifacts, type ThreadFilter, type ThreadListRow, type ThreadRow } from "./ledger";

/** Engine dependencies shared with the Telegram frontend (everything but the channel I/O). */
export type EngineDeps = Omit<PipelineDeps, "reply" | "askApproval">;

// A feed line names its recorded message and thread when the engine traced it (spec §6), so the
// console can open the thread a line belongs to.
export type WebEvent =
  | ({ type: "message"; text: string; project?: string } & LineIds)
  // The operator's own message typed on the OTHER surface (Telegram), mirrored here so both
  // surfaces show the full thread. Rendered as a `me` row (raw text, escaped client-side).
  | ({ type: "echo"; text: string } & LineIds)
  // Display-only chrome mirrored from the other surface (e.g. "approval pending on Telegram").
  | { type: "notice"; text: string }
  | { type: "escalation"; id: string; reason: string }
  | { type: "projects"; text: string; items: SelectableProject[] }
  | { type: "loops"; items: LoopInfo[] }
  | { type: "sdk"; sdk: WorkerSdkState }
  | { type: "file"; name: string; url: string; project?: string }
  // A thread changed state (ADR-0017): the console moves its row without a re-fetch.
  | ({ type: "thread"; ref?: string } & ThreadChange & Partial<Pick<ThreadListRow, "messages" | "openDecisions" | "activeTodos">>);

/** One thread as the console shows it (spec §6). `next` is the cursor for the older messages. */
export interface ThreadView {
  thread: ThreadRow & { ref?: string };
  messages: MessageRow[];
  next?: number;
  orders: ThreadArtifacts["orders"];
  todos: ThreadArtifacts["todos"];
  decisions: ThreadArtifacts["decisions"];
  /** Each plan with the actions its status offers (the card's buttons). */
  plans: Array<PlanRow & { actions: PlanAction[] }>;
  toolActions: number;
}

export interface WebChannel {
  /** Operator sent a message — drive the pipeline; streamed output arrives as events. `threadId`:
   *  the composer was opened inside that thread, so the message joins it (spec §4.1 rule 2). */
  send(text: string, opts?: { threadId?: number }): Promise<void>;
  /** Subscribe an SSE listener. The replay window is replayed first, then events go live; each
   *  event carries an increasing id. With `after` (a resume point), only later events replay. A
   *  pending escalation older than the window is replayed too (ADR-0014). */
  subscribe(listener: (e: WebEvent, id: number) => void, opts?: { after?: number }): () => void;
  /** Resolve a pending escalation (POST /approve). Returns false if the id is unknown. */
  resolveApproval(id: string, decision: "allow" | "deny"): boolean;
  /** Make a project active from a clicked /list chip (the shared engine selectProject). */
  selectProject(id: string): void;
  /** Kill a project from a clicked ✕ (the shared engine killProject), refreshing the list. */
  killProject(id: string): void;
  /** Start a project from the dashboard's New-work form (folder + task, not a typed command). */
  openProject(folder: string, task: string): Promise<void>;
  /** Run a named loop from a dashboard button. */
  runLoop(name: string): void;
  /** Create a custom loop from the console form (validated; persisted to the ledger). */
  createLoop(input: LoopInput): { ok: boolean; error?: string };
  /** Edit a custom loop (built-ins are rejected). */
  updateLoop(name: string, input: LoopInput): { ok: boolean; error?: string };
  /** Delete a custom loop (built-ins are rejected). */
  deleteLoop(name: string): { ok: boolean; error?: string };
  /** Enable/disable a loop's schedule. */
  setLoopEnabled(name: string, on: boolean): void;
  /** Switch the worker SDK used for new own-work sessions. */
  setSdk(provider: string): { ok: boolean; error?: string; sdk: WorkerSdkState };
  /** Structured snapshot for the dashboard (projects · usage · loops · recent · repos · todos). */
  state(): DashState;
  /** A Queue-tab action (`cancel 12`, `up 12`, `pause eticket-v3`, `resume eticket-v3`, or "" to
   *  list) — runs the shared /todo command, so the console and Telegram share one set of rules. */
  todo(args: string): { ok: boolean; text: string };
  /** The thread list (ADR-0017): newest-updated first, filtered, keyset-paged; each row has its ref. */
  threads(f: ThreadFilter, page: { before?: string; limit: number }): { rows: Array<ThreadListRow & { ref?: string }>; next?: string };
  /** One thread: a page of its messages (newest first) and what it produced. Undefined: no such thread. */
  thread(id: number, page: { before?: number; limit: number }): ThreadView | undefined;
  /** The projects that have threads, with their thread counts (the console's project rail). */
  threadProjects(): Array<{ project: string; threads: number }>;
  /** FTS5 search over every message, newest first, keyset-paged by id. `snippet` is safe HTML. */
  search(q: string, f: { project?: string; before?: number; limit: number }): { rows: Array<SearchHit & { ref?: string; threadRef?: string }>; next?: number };
  /** A plan card action (ADR-0019) — the same engine rules as a Telegram tap. "changes" needs the
   *  operator's text, which the console does not carry yet, so it is refused here. */
  planAction(id: number, action: PlanAction, version?: number): Promise<{ ok: boolean; text: string }>;
  /** Push a line into the operator feed (used to surface customer-driven company work). */
  notify(text: string, project?: string): void;
  /** Resolve a token issued by an outbound file event to its on-disk path (for GET /file). */
  getFile(token: string): string | undefined;
  /** Test/seam hook: deliver a file as if a worker called send_file. Returns the token. */
  _testSendFile(path: string, caption?: string): string;
}

export function createWebChannel(opts: { engine: EngineDeps; chatId: number; usage?: UsageMeter; requestReload?: () => void; bus?: OperatorBus; updates?: CommandDeps["updates"]; gated?: CommandDeps["gated"] }): WebChannel {
  // The replay window (ADR-0014): only the newest cfg.webFeedWindow feed events are kept. The
  // feed is a live view — the ledger and Telegram keep the record — so older events just drop out.
  const replay: Array<{ id: number; e: WebEvent }> = [];
  // Ids start from the boot time (µs), so they keep increasing across daemon restarts: a console left
  // open resumes with its old Last-Event-ID and still gets everything the new daemon emitted.
  let lastId = Date.now() * 1000;
  const listeners = new Set<(e: WebEvent, id: number) => void>();
  const pending = new Map<string, (d: "allow" | "deny") => void>();
  const pendingEvents = new Map<string, { id: number; e: WebEvent }>(); // escalation id -> its feed event

  function emit(e: WebEvent): number {
    const id = ++lastId;
    replay.push({ id, e });
    if (replay.length > opts.engine.cfg.webFeedWindow) replay.splice(0, replay.length - opts.engine.cfg.webFeedWindow);
    for (const l of listeners) l(e, id);
    return id;
  }
  // Worker/engine lines are Markdown — render to safe HTML once, here, so the feed shows
  // formatting (bold, code, bullets) instead of raw ** and #.
  const message = (text: string, project?: string, ids: LineIds = {}): void =>
    void emit({ type: "message", text: mdToHtml(text), project, ...knownIds(ids) });

  // Register this surface as an operator sink: lines mirrored from the OTHER surface (Telegram)
  // render here. Output-only — deliver never re-enters the pipeline, so no mirrored line can become
  // an order or re-broadcast (see operator-bus.ts). An echo carries raw text (escaped client-side).
  opts.bus?.register({
    id: "web",
    deliver: (line) => {
      // Feature 2: a mirrored reply keeps the same single colored accent the other surface shows.
      // The accent is plain emoji text, so it degrades gracefully through mdToHtml (no rich markup).
      if (line.kind === "reply") message(styleLine(line.text, line.priority), line.project, line);
      else if (line.kind === "echo") emit({ type: "echo", text: line.text, ...knownIds(line) });
      else emit({ type: "notice", text: line.text });
    },
  });

  // Live thread rows (ADR-0017). One subscription per channel for the daemon's life. The event is the
  // whole list row (counts + ref), so a moved row keeps them. Live only, never replayed: a console
  // that connects later reads the list fresh, and per-message events must not crowd the feed window.
  const trace = opts.engine.trace;
  trace?.onThreadChange((c) => {
    if (!listeners.size) return;
    const row = opts.engine.ledger.threadListRow(c.id);
    const e: WebEvent = { type: "thread", ...(row ?? c), ref: trace.ref(c.id) };
    const id = ++lastId;
    for (const l of listeners) l(e, id);
  });

  // Loops started here send the plans they wrote (ADR-0019) — only where a card can be posted.
  const loopPlans = opts.engine.postPlan ? planDepsFrom(opts.engine, opts.engine.cfg.plans) : undefined;

  const files = new Map<string, string>(); // token -> absolute path

  function deliverFile(path: string, caption?: string): string {
    const token = crypto.randomUUID();
    files.set(token, path);
    emit({ type: "file", name: basename(path), url: `/file?token=${encodeURIComponent(token)}` });
    if (caption) message(caption);
    return token;
  }

  const deps: PipelineDeps = {
    ...opts.engine,
    usage: opts.usage,
    codebaseMemory: sharedCodebaseMemoryIndexer(opts.engine.cfg),
    reply: (_chatId, text, project, priority, meta) => {
      const ids = { msgId: meta?.msgId, threadId: meta?.cause?.threadId };
      message(styleLine(text, priority), project, ids); // local delivery, styled by priority (Feature 2)
      opts.bus?.mirror("web", { kind: "reply", text, project, priority, ...knownIds(ids) }); // + mirror to Telegram
    },
    askApproval: (_chatId, reason, signal) =>
      new Promise<"allow" | "deny">((resolve) => {
        const id = crypto.randomUUID();
        pending.set(id, resolve);
        const e: WebEvent = { type: "escalation", id, reason };
        pendingEvents.set(id, { id: emit(e), e });
        // The engine gave up waiting (approval timeout, ADR-0012): drop the prompt, and stop
        // replaying it to reconnecting consoles (ADR-0014, the feed window) — nothing left to click.
        signal?.addEventListener("abort", () => {
          pendingEvents.delete(id);
          if (pending.delete(id)) resolve("deny");
        }, { once: true });
        // The actionable prompt stays here (POST /approve); the other surface just SEES it pending.
        opts.bus?.mirror("web", { kind: "notice", text: `⏳ approval pending on the web console: ${reason}` });
      }),
    sendFile: (_chatId, path, caption) => void deliverFile(path, caption),
  };

  /** Trace an operator line (ADR-0015). Contained (ADR-0010): a trace fault costs the thread, never the
   *  message — without a cause the pipeline records the line itself, as before. */
  const inbound = (text: string, threadId?: number): Cause | undefined => {
    const trace = opts.engine.trace;
    if (!trace) return undefined;
    return faults.guard("web.inbound", () => trace.inbound({ chatId: opts.chatId, text, surface: "web", threadId }));
  };

  return {
    send: async (text, sendOpts) => {
      // Bare /loop → a loops event the UI renders as run buttons (vs Telegram's text list).
      if (text.trim() === "/loop") {
        emit({ type: "loops", items: listLoops(opts.engine.ledger) });
        return;
      }
      // /loop <name> runs a long verifiable loop in the background, streaming progress.
      if (handleLoop(text, opts.chatId, { reply: (_c, t) => message(t), store: opts.engine.ledger, cfg: opts.engine.cfg, trace: opts.engine.trace, plans: loopPlans })) return;

      // Commands (/list, /usage, …) resolve synchronously and emit their reply; everything
      // else is an order or follow-up for the pipeline.
      const command = handleCommand(text, opts.chatId, {
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
        trust: opts.engine.trust,
        requestReload: opts.requestReload,
        updates: opts.updates,
        gated: opts.gated,
        cfg: opts.engine.cfg,
        windowTokensByModel: opts.engine.cfg.contextPolicy.windowTokensByModel,
        todo: opts.engine.todo,
        trace: opts.engine.trace,
      });
      if (command !== null) {
        if (command.sdk) emit({ type: "sdk", sdk: command.sdk });
        if (command.select?.length) {
          emit({ type: "projects", text: command.text, items: command.select });
        } else {
          message(command.text);
        }
        return;
      }
      // Echo the operator's own inbound to the OTHER surface (Telegram) so both show the thread.
      // Only real conversation/orders echo — synchronous commands returned above already emitted
      // their own reply. The web UI shows this message optimistically, so origin "web" is excluded.
      // Commands returned above: they open no thread (spec §4.1 rule 3). Everything else is traced first.
      const cause = inbound(text, sendOpts?.threadId);
      // Typed inside a thread: it goes to that thread's project, not the chat's focus (AC3.4). A slash
      // line is an order, not a follow-up — the pipeline never uses a focus for it, so none is set.
      let deliver = text;
      const { registry } = opts.engine;
      const pin = registry.getFocus(opts.chatId);
      const threaded = sendOpts?.threadId !== undefined && !text.trim().startsWith("/");
      if (threaded && sendOpts?.threadId !== undefined) {
        const routing = routeThreadMessage(
          { registry: opts.engine.registry, ledger: opts.engine.ledger, worker: opts.engine.cfg.providers.ownWork },
          { chatId: opts.chatId, threadId: sendOpts.threadId, text },
        );
        if ("clarify" in routing) {
          message(routing.clarify);
          return;
        }
        deliver = routing.deliver;
      }
      opts.bus?.mirror("web", { kind: "echo", text, ...knownIds({ msgId: cause?.msgId, threadId: cause?.threadId }) });
      await handleMessage(deliver, opts.chatId, deps, "neo", cause);
      // The thread's one-shot focus took the chat's only focus slot: once it is used, the pin returns.
      if (threaded && pin?.mode === "pinned" && !registry.getFocus(opts.chatId) && registry.get(pin.session.id)) {
        registry.setFocus(opts.chatId, pin.session.id, "pinned");
      }
    },
    subscribe(listener, sub) {
      const after = sub?.after ?? 0;
      const oldest = replay[0]?.id ?? lastId + 1;
      // A pending escalation that fell out of the window must still be answerable on this console.
      for (const p of pendingEvents.values()) if (p.id > after && p.id < oldest) listener(p.e, p.id);
      for (const { id, e } of replay) {
        if (id <= after) continue;
        if (e.type === "escalation" && !pendingEvents.has(e.id)) continue; // answered: nothing to click
        listener(e, id);
      }
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    resolveApproval(id, decision) {
      const resolve = pending.get(id);
      if (!resolve) return false;
      pending.delete(id);
      pendingEvents.delete(id);
      resolve(decision);
      opts.bus?.mirror("web", { kind: "notice", text: `approval ${decision} on the web console` });
      return true;
    },
    selectProject(id) {
      const result = engineSelectProject(id, opts.chatId, {
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
        trust: opts.engine.trust,
        windowTokensByModel: opts.engine.cfg.contextPolicy.windowTokensByModel,
      });
      emit({ type: "projects", text: result.text, items: result.select ?? [] });
    },
    killProject(id) {
      const result = engineKillProject(id, opts.chatId, {
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
        trust: opts.engine.trust,
        windowTokensByModel: opts.engine.cfg.contextPolicy.windowTokensByModel,
      });
      emit({ type: "projects", text: result.text, items: result.select ?? [] });
    },
    openProject(folder, task) {
      // The user used a form; we construct the order. Reuses the governed pipeline.
      const text = `/open ${folder} ${task}`;
      return handleMessage(text, opts.chatId, deps, "neo", inbound(text)).then(() => undefined);
    },
    runLoop(name) {
      const loop = matchLoop(name, opts.engine.ledger);
      if (loop) launchLoop(loop, opts.chatId, { reply: (_c, t) => message(t), store: opts.engine.ledger, cfg: opts.engine.cfg, trace: opts.engine.trace, plans: loopPlans });
    },
    createLoop(input) {
      const r = defCreateLoop(input, opts.engine.ledger, opts.engine.cfg.workRoot);
      if (r.ok) emit({ type: "loops", items: listLoops(opts.engine.ledger) });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    updateLoop(name, input) {
      const r = defUpdateLoop(name, input, opts.engine.ledger, opts.engine.cfg.workRoot);
      if (r.ok) emit({ type: "loops", items: listLoops(opts.engine.ledger) });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    deleteLoop(name) {
      const r = defDeleteLoop(name, opts.engine.ledger);
      if (r.ok) emit({ type: "loops", items: listLoops(opts.engine.ledger) });
      return r;
    },
    setLoopEnabled(name, on) {
      opts.engine.ledger.setEnabled(name, on);
      emit({ type: "loops", items: listLoops(opts.engine.ledger) });
    },
    setSdk(provider) {
      const result = setWorkerSdk(opts.engine.cfg, provider);
      if (result.ok) emit({ type: "sdk", sdk: result.sdk });
      return result.ok ? { ok: true, sdk: result.sdk } : { ok: false, error: result.error, sdk: result.sdk };
    },
    state() {
      return dashboardSnapshot({
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
        chatId: opts.chatId,
        reposRoot: opts.engine.cfg.workRoot, // scan the operator's configured project root
        sdkProvider: opts.engine.cfg.providers.ownWork,
        windowTokensByModel: opts.engine.cfg.contextPolicy.windowTokensByModel,
      });
    },
    threads(f, page) {
      const trace = opts.engine.trace;
      const r = opts.engine.ledger.listThreads(f, page);
      return { ...r, rows: r.rows.map((t) => ({ ...t, ...(trace ? { ref: trace.ref(t.id) } : {}) })) };
    },
    thread(id, page) {
      const { ledger, trace } = opts.engine;
      const t = ledger.threadById(id);
      if (!t) return undefined;
      const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(page.limit) || PAGE_MAX));
      // One row past the page tells whether an older page exists.
      const rows = ledger.messagesInThread(id, { before: page.before, limit: limit + 1 });
      const messages = rows.slice(0, limit);
      const art = ledger.threadArtifacts(id, PAGE_MAX);
      return {
        thread: { ...t, ...(trace ? { ref: trace.ref(id) } : {}) },
        messages,
        ...(rows.length > limit ? { next: messages.at(-1)!.id } : {}),
        orders: art.orders,
        todos: art.todos,
        decisions: art.decisions,
        plans: ledger.plansInThread(id, PAGE_MAX).map((p) => ({ ...p, actions: planActions(p.status) })),
        toolActions: art.toolActions,
      };
    },
    threadProjects() {
      return opts.engine.ledger.threadProjects(PAGE_MAX);
    },
    search(q, f) {
      const trace = opts.engine.trace;
      const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(f.limit) || PAGE_MAX));
      const hits = opts.engine.ledger.searchMessages(q, { ...f, limit: limit + 1 });
      const rows = hits.slice(0, limit).map((h) => ({
        ...h,
        snippet: snippetHtml(h.snippet),
        ...(trace ? { ref: trace.ref(h.id), ...(h.threadId !== undefined ? { threadRef: trace.ref(h.threadId) } : {}) } : {}),
      }));
      return { rows, ...(hits.length > limit ? { next: rows.at(-1)!.id } : {}) };
    },
    async planAction(id, action, version) {
      if (action === "changes") return { ok: false, text: "reply to the plan card on Telegram with your changes" };
      const r = await applyPlanAction(planDepsFrom(opts.engine, opts.engine.cfg.plans), id, action, version);
      opts.bus?.mirror("web", { kind: "notice", text: `plan #${id}: ${r.text} (web console)` });
      return r;
    },
    todo(args) {
      const r = handleCommand(`/todo ${args}`.trim(), opts.chatId, {
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        trust: opts.engine.trust,
        todo: opts.engine.todo,
      });
      return { ok: !!opts.engine.todo, text: r?.text ?? "" };
    },
    notify(text: string, project?: string) {
      message(text, project); // reuse the existing markdown→HTML message emitter
    },
    getFile: (token) => files.get(token),
    _testSendFile: (path, caption) => deliverFile(path, caption),
  };
}
