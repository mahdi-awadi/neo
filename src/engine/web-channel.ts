// Web operator channel: a thin adapter that drives the SAME engine pipeline as Telegram
// (handleMessage, source "neo" -> Agent SDK on the subscription), but renders streamed
// worker output + escalations as events an HTTP/SSE layer can fan out, and resolves
// Allow/Deny approvals out-of-band (the web equivalent of Telegram's inline buttons).
// All logic lives here (tested); frontends/web.ts is just Bun.serve glue over it.
import { controlTool, DEFAULT_TOOL_CONTROL_CFG, type ToolAction, type ToolControlResult } from "./tool-control";
import type { RunningBuild } from "./producers/restart";
import { applyAttentionAction, type AttentionAction, type AttentionActionResult } from "./attention-actions";
import { DEFAULT_ATTENTION_CFG } from "./producers/engine";
import { rmSync } from "node:fs";
import { basename } from "node:path";
import { saveInbound, withAttachments, type AttachedFile } from "./files";
import { handleMessage, type PipelineDeps } from "./pipeline";
import { parseOrder } from "./orders";
import { ledgerIndexStore, sharedCodebaseMemoryIndexer } from "./codebase-memory";
import {
  handleCommand,
  selectProject as engineSelectProject,
  killProject as engineKillProject,
  type SelectableProject,
  type CommandDeps,
  type CommandResult,
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
import { dashboardSnapshot, todoDetail, type DashState, type TodoDetail } from "./dashboard";
import { snippetHtml } from "./format";
import { feedLine, reasonHtml, type LineTone } from "./feed-line";
import { styleLine } from "./priority";
import type { UsageMeter } from "./usage";
import { knownIds, type LineIds, type OperatorBus } from "./operator-bus";
import { setWorkerSdk, type WorkerSdkState } from "./sdk-choice";
import type { Cause, ThreadChange, ThreadCloseResult } from "./trace";
import { faults } from "./fault";
import { applyPlanAction, planActions, planDepsFrom, planState, type PlanAction, type PlanActionResult, type PlanState } from "./plans";
import { answerDecision, routeThreadMessage } from "./reply-routing";
import { projectDeps, projectSummaries, projectView, type ProjectSummary, type ProjectView } from "./project-view";
import { PAGE_MAX, type MessageRow, type PlanRow, type SearchHit, type ThreadArtifacts, type ThreadFilter, type ThreadListRow, type ThreadRow } from "./ledger";
import { waitingWork, type WaitingItem } from "./waiting-work";
import { DEFAULT_KEEP_PATTERNS } from "./decision-settle";
import { needsYou, pin, type NeedsYouItem } from "./needs-you";
import type { PinState } from "./ledger";

/** Engine dependencies shared with the Telegram frontend (everything but the channel I/O). */
export type EngineDeps = Omit<PipelineDeps, "reply" | "askApproval">;

// A feed line names its recorded message and thread when the engine traced it (spec §6), so the
// console can open the thread a line belongs to.
export type WebEvent =
  // `text` is safe HTML (feedLine, ADR-0025); `tone` is the row's colour class.
  | ({ type: "message"; text: string; tone: LineTone; project?: string } & LineIds)
  // The operator's own message typed on the OTHER surface (Telegram), mirrored here so both
  // surfaces show the full thread. Rendered as a `me` row (raw text, escaped client-side).
  | ({ type: "echo"; text: string } & LineIds)
  // Display-only chrome mirrored from the other surface (e.g. "approval pending on Telegram").
  | { type: "notice"; text: string }
  | { type: "escalation"; id: string; reason: string; html: string }
  | { type: "projects"; text: string; items: SelectableProject[] }
  | { type: "loops"; items: LoopInfo[] }
  | { type: "sdk"; sdk: WorkerSdkState }
  | { type: "file"; name: string; url: string; project?: string }
  // What needs the operator (ADR-0018, /attention): the list and its one-tap items.
  | { type: "attention"; text: string; items: NonNullable<CommandResult["attention"]>; snoozeHours: number }
  // A thread changed state (ADR-0017): the console moves its row without a re-fetch.
  | ({ type: "thread"; ref?: string } & ThreadChange & Partial<Pick<ThreadListRow, "messages" | "openDecisions" | "activeTodos">>);

/** One thread as the console shows it (spec §6). `next` is the cursor for the older messages. */
export interface ThreadView {
  thread: ThreadRow & { ref?: string };
  /** An assistant row carries its rendered `html` and `tone` (ADR-0025); an operator row stays text. */
  messages: Array<MessageRow & { html?: string; tone?: LineTone }>;
  next?: number;
  orders: ThreadArtifacts["orders"];
  todos: ThreadArtifacts["todos"];
  decisions: ThreadArtifacts["decisions"];
  /** Each plan with the actions its status offers (the card's buttons). */
  plans: Array<PlanRow & { state: PlanState; actions: PlanAction[] }>;
  toolActions: number;
}

/** A staged attachment as the composer sees it: the token to send, the saved name and its size. */
export interface StagedFile {
  token: string;
  name: string;
  size: number;
}

export type SendCheck = { ok: true } | { error: "expired" | "command" };

/** A staged attachment nobody sent is forgotten after this long (its file stays in the inbox). */
export const STAGE_TTL_MS = 6 * 60 * 60 * 1000;

export interface WebChannel {
  /** Operator sent a message — drive the pipeline; streamed output arrives as events. `threadId`:
   *  the composer was opened inside that thread, so the message joins it (spec §4.1 rule 2). */
  send(text: string, opts?: { threadId?: number; attachments?: string[] }): Promise<void>;
  /** Would `send` take this message? `expired`: a staged file is unknown or gone (reload, TTL).
   *  `command`: files with a slash line that is not an order. Synchronous, so /msg can answer at once. */
  check(text: string, opts?: { attachments?: string[] }): SendCheck;
  /** Stage a file attached in the composer (ADR-0026): save it to an inbox (the thread's project when
   *  `threadId` names one with a folder, else the active project) and return a one-shot token that
   *  `send` turns into the message's file list. Nothing is sent. */
  stage(file: { name: string; bytes: Uint8Array }, opts?: { threadId?: number }): StagedFile | { error: string };
  /** The operator took a staged file out of the composer: forget it and delete it. False: unknown token. */
  discard(token: string): boolean;
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
  /** Stop or background one running tool call (ADR-0058), as the operator in the console. */
  toolControl(sessionId: string, toolUseId: string, action: ToolAction): Promise<ToolControlResult>;
  /** The thread list (ADR-0017): newest-updated first, filtered, keyset-paged; each row has its ref. */
  threads(f: ThreadFilter, page: { before?: string; limit: number }): { rows: Array<ThreadListRow & { ref?: string; waiting?: WaitingItem[] }>; next?: string };
  /** One thread: a page of its messages (newest first) and what it produced. Undefined: no such thread. */
  thread(id: number, page: { before?: number; limit: number }): ThreadView | undefined;
  /** The projects that have threads, with their thread counts (the console's project rail). */
  threadProjects(): Array<{ project: string; threads: number }>;
  /** FTS5 search over every message, newest first, keyset-paged by id. `snippet` is safe HTML. */
  search(q: string, f: { project?: string; before?: number; limit: number }): { rows: Array<SearchHit & { ref?: string; threadRef?: string }>; next?: number };
  /** A plan card action (ADR-0019) — the same engine rules as a Telegram tap. "changes" needs the
   *  operator's text, which the console does not carry yet, so it is refused here. */
  planAction(id: number, action: PlanAction, version?: number): Promise<PlanActionResult>;
  /** The operator closes a thread (ADR-0038). Undefined: no such thread (or no tracing). */
  closeThread(id: number): (ThreadCloseResult & { ok: true }) | undefined;
  /** An attention item's one-tap action (ADR-0018) — the same engine rules as a Telegram tap. */
  attentionAction(id: number, action: AttentionAction): Promise<AttentionActionResult>;
  /** The project list (P6, spec §9): one summary per known project, health first, at most PAGE_MAX. */
  projects(): { rows: ProjectSummary[]; total: number };
  /** ADR-0065: everything that needs the operator (the pinned strip). */
  needsYou(): NeedsYouItem[];
  /** ADR-0065: pin, unpin or clear one item; refused for a closed or unknown one. */
  pin(ref: string, state: PinState | null): { ok: true; text: string } | { ok: false; error: string };
  /** ADR-0065: one todo's detail, or undefined. */
  todoDetail(id: number): TodoDetail | undefined;
  /** One project's dashboard, with the snooze hours its attention buttons name. Undefined: no such project. */
  project(name: string): Promise<(ProjectView & { snoozeHours: number }) | undefined>;
  /** Push a line into the operator feed (used to surface customer-driven company work). */
  notify(text: string, project?: string): void;
  /** Resolve a token issued by an outbound file event to its on-disk path (for GET /file). */
  getFile(token: string): string | undefined;
  /** Test/seam hook: deliver a file as if a worker called send_file. Returns the token. */
  _testSendFile(path: string, caption?: string): string;
}

export function createWebChannel(opts: { engine: EngineDeps; chatId: number; usage?: UsageMeter; requestReload?: () => void; bus?: OperatorBus; updates?: CommandDeps["updates"]; gated?: CommandDeps["gated"]; deployGap?: CommandDeps["deployGap"]; build?: RunningBuild; neoFolder?: string }): WebChannel {
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
  // Worker/engine lines render to safe HTML once, here (ADR-0025): Markdown as formatted content, an
  // engine step line's command or output as code, plus the row's colour tone.
  const message = (text: string, project?: string, ids: LineIds = {}): void => {
    const { html, tone } = feedLine(text);
    void emit({ type: "message", text: html, tone, project, ...knownIds(ids) });
  };

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

  // Staged attachments (ADR-0026): token -> the saved file, until a send takes it or it expires. The
  // browser only ever holds the token, never a server path.
  const stagedFiles = new Map<string, AttachedFile & { at: number }>();
  const dropExpired = (now: number): void => {
    for (const [token, f] of stagedFiles) if (now - f.at > STAGE_TTL_MS) stagedFiles.delete(token);
  };
  /** The staged files named by `tokens`, in the order given; undefined when any is unknown or expired
   *  (a reload or the TTL forgot it). Read-only: `send` deletes them once the message is routed. */
  const stagedFor = (tokens: string[] = []): AttachedFile[] | undefined => {
    dropExpired(Date.now());
    const out: AttachedFile[] = [];
    for (const token of tokens) {
      const f = stagedFiles.get(token);
      if (!f) return undefined;
      out.push({ name: f.name, path: f.path });
    }
    return out;
  };
  const check = (text: string, sendOpts?: { attachments?: string[] }): SendCheck => {
    const attached = stagedFor(sendOpts?.attachments);
    if (!attached) return { error: "expired" };
    // A console command cannot carry files, and any other slash line reaches the pipeline as an order:
    // only a real order (/open) may take them.
    if (attached.length && text.trim().startsWith("/") && "error" in parseOrder(text, "neo", opts.chatId)) return { error: "command" };
    return { ok: true };
  };

  const deps: PipelineDeps = {
    ...opts.engine,
    usage: opts.usage,
    codebaseMemory: sharedCodebaseMemoryIndexer(opts.engine.cfg, ledgerIndexStore(opts.engine.ledger)),
    reply: (_chatId, text, project, priority, meta) => {
      const ids = { msgId: meta?.msgId, threadId: meta?.cause?.threadId };
      message(styleLine(text, priority), project, ids); // local delivery, styled by priority (Feature 2)
      opts.bus?.mirror("web", { kind: "reply", text, project, priority, ...knownIds(ids) }); // + mirror to Telegram
    },
    askApproval: (_chatId, reason, signal) =>
      new Promise<"allow" | "deny">((resolve) => {
        const id = crypto.randomUUID();
        pending.set(id, resolve);
        const e: WebEvent = { type: "escalation", id, reason, html: reasonHtml(reason) };
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
    check,
    send: async (typed, sendOpts) => {
      // Staged files travel with the words they belong to (ADR-0026): one message, one row, one prompt.
      // A message with files is never a console command — the files must reach a worker. A send that
      // fails `check` does nothing: /msg already told the composer, which keeps its text and chips.
      if ("error" in check(typed, sendOpts)) return;
      const attached = stagedFor(sendOpts?.attachments) ?? [];
      const text = withAttachments(typed, attached);
      const commandable = attached.length === 0;
      // Bare /loop → a loops event the UI renders as run buttons (vs Telegram's text list).
      if (commandable && text.trim() === "/loop") {
        emit({ type: "loops", items: listLoops(opts.engine.ledger) });
        return;
      }
      // /loop <name> runs a long verifiable loop in the background, streaming progress.
      if (commandable && handleLoop(text, opts.chatId, { reply: (_c, t) => message(t), store: opts.engine.ledger, cfg: opts.engine.cfg, trace: opts.engine.trace, plans: loopPlans })) return;

      // Commands (/list, /usage, …) resolve synchronously and emit their reply; everything
      // else is an order or follow-up for the pipeline.
      const command = !commandable ? null : handleCommand(text, opts.chatId, {
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        ...(opts.engine.cfg.toolControl ? { toolControl: opts.engine.cfg.toolControl } : {}),
        usage: opts.usage,
        trust: opts.engine.trust,
        requestReload: opts.requestReload,
        updates: opts.updates,
        gated: opts.gated,
        deployGap: opts.deployGap,
        cfg: opts.engine.cfg,
        windowTokensByModel: opts.engine.cfg.contextPolicy.windowTokensByModel,
        todo: opts.engine.todo,
        trace: opts.engine.trace,
        neoFolder: opts.neoFolder,
      });
      if (command !== null) {
        if (command.later) {
          message((await command.later).text); // /project: the console's own tab has its buttons
          return;
        }
        if (command.sdk) emit({ type: "sdk", sdk: command.sdk });
        if (command.attention?.length) {
          emit({ type: "attention", text: command.text, items: command.attention, snoozeHours: (opts.engine.cfg.attention ?? DEFAULT_ATTENTION_CFG).snoozeHours });
        } else if (command.select?.length) {
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
          message(routing.clarify); // the files stay staged for the resend
          return;
        }
        deliver = routing.deliver;
      }
      for (const token of sendOpts?.attachments ?? []) stagedFiles.delete(token); // routed: one-shot
      opts.bus?.mirror("web", { kind: "echo", text, ...knownIds({ msgId: cause?.msgId, threadId: cause?.threadId }) });
      await handleMessage(deliver, opts.chatId, deps, "neo", cause);
      // The thread's one-shot focus took the chat's only focus slot: once it is used, the pin returns.
      if (threaded && pin?.mode === "pinned" && !registry.getFocus(opts.chatId) && registry.get(pin.session.id)) {
        registry.setFocus(opts.chatId, pin.session.id, "pinned");
      }
    },
    stage(file, stageOpts) {
      const now = Date.now();
      dropExpired(now);
      // Inside a thread the file belongs to that thread's project; otherwise the active project, as
      // Telegram's attachments do.
      const threadFolder = stageOpts?.threadId === undefined ? undefined : opts.engine.ledger.threadById(stageOpts.threadId)?.folder;
      const folder = threadFolder || (opts.engine.registry.findByChat(opts.chatId) ?? opts.engine.registry.getDefault())?.order.folder;
      if (!folder) return { error: "no active project" };
      const path = saveInbound(folder, file.name || "file", file.bytes);
      const token = crypto.randomUUID();
      stagedFiles.set(token, { name: basename(path), path, at: now });
      return { token, name: basename(path), size: file.bytes.byteLength };
    },
    discard(token) {
      const f = stagedFiles.get(token);
      if (!f) return false;
      stagedFiles.delete(token);
      rmSync(f.path, { force: true });
      return true;
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
      const deploy = opts.deployGap?.();
      return dashboardSnapshot({
        ...(deploy ? { deploy } : {}),
        ...(opts.build ? { build: opts.build } : {}),
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
        chatId: opts.chatId,
        reposRoot: opts.engine.cfg.workRoot, // scan the operator's configured project root
        sdkProvider: opts.engine.cfg.providers.ownWork,
        windowTokensByModel: opts.engine.cfg.contextPolicy.windowTokensByModel,
        ...(opts.engine.cfg.decisionSettle ? { keepPatterns: opts.engine.cfg.decisionSettle.keepPatterns } : {}),
      });
    },
    threads(f, page) {
      const trace = opts.engine.trace;
      const r = opts.engine.ledger.listThreads(f, page);
      // A WAITING row says who owes what (ADR-0054): its decision items, read once per page.
      const byThread = new Map<number, WaitingItem[]>();
      if (r.rows.some((t) => t.state === "waiting")) {
        const keepPatterns = opts.engine.cfg.decisionSettle?.keepPatterns ?? DEFAULT_KEEP_PATTERNS;
        for (const i of waitingWork(opts.engine.ledger, { keepPatterns })) {
          if (i.threadId === undefined || i.kind === "parked_todo") continue;
          byThread.set(i.threadId, [...(byThread.get(i.threadId) ?? []), i]);
        }
      }
      return {
        ...r,
        rows: r.rows.map((t) => ({ ...t, ...(trace ? { ref: trace.ref(t.id) } : {}), ...(t.state === "waiting" && byThread.has(t.id) ? { waiting: byThread.get(t.id)! } : {}) })),
      };
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
        messages: messages.map((m) => (m.role === "assistant" ? { ...m, ...feedLine(m.content) } : m)),
        ...(rows.length > limit ? { next: messages.at(-1)!.id } : {}),
        orders: art.orders,
        todos: art.todos,
        decisions: art.decisions,
        plans: ledger.plansInThread(id, PAGE_MAX).map((p) => ({ ...p, state: planState(p), actions: planActions(p) })),
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
    closeThread(id) {
      const { ledger, trace } = opts.engine;
      if (!trace || !ledger.threadById(id)) return undefined;
      return { ok: true as const, ...trace.close(id) };
    },
    async planAction(id, action, version) {
      if (action === "changes") return { ok: false, text: "reply to the plan card on Telegram with your changes" };
      const r = await applyPlanAction(planDepsFrom(opts.engine, opts.engine.cfg.plans), id, action, version, { canResume: true });
      opts.bus?.mirror("web", { kind: "notice", text: `plan #${id}: ${r.text} (web console)` });
      // Approve & build on a plan a worker is held on (ADR-0036): answer its decision — the same path
      // as a Telegram answer — so that worker resumes and builds.
      const dec = r.resume ? opts.engine.ledger.decisionById(r.resume.decisionId) : undefined;
      if (r.resume && dec) {
        const { registry, ledger, todo, cfg } = opts.engine;
        const resumed = answerDecision(
          { registry, ledger, worker: cfg.providers.ownWork, ...(todo ? { parked: (d, a) => !!todo.decisionAnswered(d.id, d.question, a) } : {}) },
          dec,
          r.resume.answer,
          opts.chatId,
        );
        if (resumed) void faults.contain("web.planResume", handleMessage(resumed.brief, resumed.homeChat, deps, "neo", inbound(r.resume.answer, dec.cause?.threadId)));
      }
      return r;
    },
    async attentionAction(id, action) {
      const { ledger, registry, todo, trace, cfg } = opts.engine;
      const r = await applyAttentionAction({ ledger, registry, todo, trace, snoozeMs: (cfg.attention ?? DEFAULT_ATTENTION_CFG).snoozeHours * 3_600_000 }, id, action, Date.now());
      opts.bus?.mirror("web", { kind: "notice", text: `attention #${id}: ${r.text} (web console)` });
      return r;
    },
    needsYou() {
      const { ledger, cfg } = opts.engine;
      return needsYou({ ledger, keepPatterns: cfg.decisionSettle?.keepPatterns ?? DEFAULT_KEEP_PATTERNS }, Date.now());
    },
    pin(ref, state) {
      return pin(opts.engine.ledger, ref, state, Date.now());
    },
    todoDetail(id) {
      return todoDetail(opts.engine.ledger, id);
    },
    projects() {
      const { ledger, registry, cfg } = opts.engine;
      return projectSummaries(projectDeps({ ledger, registry, cfg, neoFolder: opts.neoFolder }), Date.now(), PAGE_MAX);
    },
    async project(name) {
      const { ledger, registry, cfg } = opts.engine;
      const v = await projectView(projectDeps({ ledger, registry, cfg, neoFolder: opts.neoFolder }), name, Date.now());
      return v ? { ...v, snoozeHours: (cfg.attention ?? DEFAULT_ATTENTION_CFG).snoozeHours } : undefined;
    },
    toolControl(sessionId, toolUseId, action) {
      return controlTool(
        { registry: opts.engine.registry, ledger: opts.engine.ledger, cfg: opts.engine.cfg.toolControl ?? DEFAULT_TOOL_CONTROL_CFG },
        { sessionId, toolUseId, action, by: { kind: "operator", surface: "web" } },
      );
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
