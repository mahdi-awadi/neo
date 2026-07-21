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
} from "./commands";
import {
  handleLoop,
  listLoops,
  matchLoop,
  startLoop,
  createLoop as defCreateLoop,
  updateLoop as defUpdateLoop,
  deleteLoop as defDeleteLoop,
  type LoopInfo,
} from "./loops";
import type { LoopInput } from "./loop-validate";
import { dashboardSnapshot, type DashState } from "./dashboard";
import { mdToHtml } from "./format";
import type { UsageMeter } from "./usage";

/** Engine dependencies shared with the Telegram frontend (everything but the channel I/O). */
export type EngineDeps = Omit<PipelineDeps, "reply" | "askApproval">;

export type WebEvent =
  | { type: "message"; text: string; project?: string }
  | { type: "escalation"; id: string; reason: string }
  | { type: "projects"; text: string; items: SelectableProject[] }
  | { type: "loops"; items: LoopInfo[] }
  | { type: "file"; name: string; url: string; project?: string };

export interface WebChannel {
  /** Operator sent a message — drive the pipeline; streamed output arrives as events. */
  send(text: string): Promise<void>;
  /** Subscribe an SSE listener; past events are replayed first (reconnect-safe). */
  subscribe(listener: (e: WebEvent) => void): () => void;
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
  /** Structured snapshot for the dashboard (projects · usage · loops · recent · repos). */
  state(): DashState;
  /** Push a line into the operator feed (used to surface customer-driven company work). */
  notify(text: string, project?: string): void;
  /** Resolve a token issued by an outbound file event to its on-disk path (for GET /file). */
  getFile(token: string): string | undefined;
  /** Test/seam hook: deliver a file as if a worker called send_file. Returns the token. */
  _testSendFile(path: string, caption?: string): string;
}

export function createWebChannel(opts: { engine: EngineDeps; chatId: number; usage?: UsageMeter; requestReload?: () => void }): WebChannel {
  const events: WebEvent[] = [];
  const listeners = new Set<(e: WebEvent) => void>();
  const pending = new Map<string, (d: "allow" | "deny") => void>();

  function emit(e: WebEvent): void {
    events.push(e);
    for (const l of listeners) l(e);
  }
  // Worker/engine lines are Markdown — render to safe HTML once, here, so the feed shows
  // formatting (bold, code, bullets) instead of raw ** and #.
  const message = (text: string, project?: string) => emit({ type: "message", text: mdToHtml(text), project });

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
    reply: (_chatId, text, project) => message(text, project),
    askApproval: (_chatId, reason) =>
      new Promise<"allow" | "deny">((resolve) => {
        const id = crypto.randomUUID();
        pending.set(id, resolve);
        emit({ type: "escalation", id, reason });
      }),
    sendFile: (_chatId, path, caption) => void deliverFile(path, caption),
  };

  return {
    send: async (text) => {
      // Bare /loop → a loops event the UI renders as run buttons (vs Telegram's text list).
      if (text.trim() === "/loop") {
        emit({ type: "loops", items: listLoops(opts.engine.ledger) });
        return;
      }
      // /loop <name> runs a long verifiable loop in the background, streaming progress.
      if (handleLoop(text, opts.chatId, { reply: (_c, t) => message(t), store: opts.engine.ledger })) return;

      // Commands (/list, /usage, …) resolve synchronously and emit their reply; everything
      // else is an order or follow-up for the pipeline.
      const command = handleCommand(text, opts.chatId, {
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
        trust: opts.engine.trust,
        requestReload: opts.requestReload,
      });
      if (command !== null) {
        if (command.select?.length) {
          emit({ type: "projects", text: command.text, items: command.select });
        } else {
          message(command.text);
        }
        return;
      }
      await handleMessage(text, opts.chatId, deps);
    },
    subscribe(listener) {
      for (const e of events) listener(e); // replay history, then go live
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    resolveApproval(id, decision) {
      const resolve = pending.get(id);
      if (!resolve) return false;
      pending.delete(id);
      resolve(decision);
      return true;
    },
    selectProject(id) {
      const result = engineSelectProject(id, opts.chatId, {
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
        trust: opts.engine.trust,
      });
      emit({ type: "projects", text: result.text, items: result.select ?? [] });
    },
    killProject(id) {
      const result = engineKillProject(id, opts.chatId, {
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
        trust: opts.engine.trust,
      });
      emit({ type: "projects", text: result.text, items: result.select ?? [] });
    },
    openProject(folder, task) {
      // The user used a form; we construct the order. Reuses the governed pipeline.
      return handleMessage(`/open ${folder} ${task}`, opts.chatId, deps).then(() => undefined);
    },
    runLoop(name) {
      const loop = matchLoop(name, opts.engine.ledger);
      if (loop) void startLoop(loop, opts.chatId, { reply: (_c, t) => message(t), store: opts.engine.ledger });
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
    state() {
      return dashboardSnapshot({
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
        chatId: opts.chatId,
        reposRoot: opts.engine.cfg.workRoot, // scan the operator's configured project root
      });
    },
    notify(text: string, project?: string) {
      message(text, project); // reuse the existing markdown→HTML message emitter
    },
    getFile: (token) => files.get(token),
    _testSendFile: (path, caption) => deliverFile(path, caption),
  };
}
