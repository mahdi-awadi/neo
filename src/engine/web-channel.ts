// Web operator channel: a thin adapter that drives the SAME engine pipeline as Telegram
// (handleMessage, source "neo" -> Agent SDK on the subscription), but renders streamed
// worker output + escalations as events an HTTP/SSE layer can fan out, and resolves
// Allow/Deny approvals out-of-band (the web equivalent of Telegram's inline buttons).
// All logic lives here (tested); frontends/web.ts is just Bun.serve glue over it.
import { handleMessage, type PipelineDeps } from "./pipeline";
import { handleCommand, selectProject as engineSelectProject, type SelectableProject } from "./commands";
import type { UsageMeter } from "./usage";

/** Engine dependencies shared with the Telegram frontend (everything but the channel I/O). */
export type EngineDeps = Omit<PipelineDeps, "reply" | "askApproval">;

export type WebEvent =
  | { type: "message"; text: string }
  | { type: "escalation"; id: string; reason: string }
  | { type: "projects"; text: string; items: SelectableProject[] };

export interface WebChannel {
  /** Operator sent a message — drive the pipeline; streamed output arrives as events. */
  send(text: string): Promise<void>;
  /** Subscribe an SSE listener; past events are replayed first (reconnect-safe). */
  subscribe(listener: (e: WebEvent) => void): () => void;
  /** Resolve a pending escalation (POST /approve). Returns false if the id is unknown. */
  resolveApproval(id: string, decision: "allow" | "deny"): boolean;
  /** Make a project active from a clicked /list chip (the shared engine selectProject). */
  selectProject(id: string): void;
}

export function createWebChannel(opts: { engine: EngineDeps; chatId: number; usage?: UsageMeter }): WebChannel {
  const events: WebEvent[] = [];
  const listeners = new Set<(e: WebEvent) => void>();
  const pending = new Map<string, (d: "allow" | "deny") => void>();

  function emit(e: WebEvent): void {
    events.push(e);
    for (const l of listeners) l(e);
  }

  const deps: PipelineDeps = {
    ...opts.engine,
    usage: opts.usage,
    reply: (_chatId, text) => emit({ type: "message", text }),
    askApproval: (_chatId, reason) =>
      new Promise<"allow" | "deny">((resolve) => {
        const id = crypto.randomUUID();
        pending.set(id, resolve);
        emit({ type: "escalation", id, reason });
      }),
  };

  return {
    send: async (text) => {
      // Commands (/list, /usage, …) resolve synchronously and emit their reply; everything
      // else is an order or follow-up for the pipeline.
      const command = handleCommand(text, opts.chatId, {
        registry: opts.engine.registry,
        ledger: opts.engine.ledger,
        usage: opts.usage,
      });
      if (command !== null) {
        if (command.select?.length) {
          emit({ type: "projects", text: command.text, items: command.select });
        } else {
          emit({ type: "message", text: command.text });
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
      });
      emit({ type: "projects", text: result.text, items: result.select ?? [] });
    },
  };
}
