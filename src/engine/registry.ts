// Tracks the live worker sessions the engine is driving (in-process SDK handles).
// Unlike operant's session-registry (built for external processes reconnecting over a
// socket), these sessions are owned by the engine — no reconnect/ghost-slot logic.
// Keyed by the stable order id; addressable by short name (for /kill) and by chat (for
// follow-up routing). The unique-name scheme is ported from operant, trimmed.
import { basename } from "node:path";
import type { Order, SessionControl, SessionInfo } from "../types";

/** Statuses for a session that is still live (followable / killable). */
const OPEN: ReadonlySet<SessionInfo["status"]> = new Set(["running", "idle"]);

export interface Registry {
  /** Register a freshly-started session. Returns the created entry (name may be uniquified). */
  add(order: Order, now?: number): SessionInfo;
  get(id: string): SessionInfo | undefined;
  list(): SessionInfo[];
  remove(id: string): void;
  /** The most recently active OPEN session for a chat — the natural follow-up target. */
  findByChat(chatId: number): SessionInfo | undefined;
  findByName(name: string): SessionInfo | undefined;
  setStatus(id: string, status: SessionInfo["status"]): void;
  setSdkSessionId(id: string, sdkSessionId: string): void;
  touch(id: string, now?: number): void;
  /** Attach the live control handle so follow-up / kill / idle-close can reach it. */
  attachControl(id: string, control: SessionControl): void;
  getControl(id: string): SessionControl | undefined;
}

export function createRegistry(): Registry {
  const sessions = new Map<string, SessionInfo>();
  const controls = new Map<string, SessionControl>();

  function uniqueName(base: string): string {
    const taken = new Set([...sessions.values()].map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  return {
    add(order, now = Date.now()) {
      const session: SessionInfo = {
        id: order.id,
        name: uniqueName(basename(order.folder)),
        sdkSessionId: "",
        order,
        status: "running",
        startedAt: now,
        lastActivityAt: now,
      };
      sessions.set(session.id, session);
      return session;
    },
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
    remove: (id) => {
      sessions.delete(id);
      controls.delete(id);
    },
    attachControl: (id, control) => void controls.set(id, control),
    getControl: (id) => controls.get(id),
    findByChat(chatId) {
      return [...sessions.values()]
        .filter((s) => s.order.chatId === chatId && OPEN.has(s.status))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    },
    findByName: (name) => [...sessions.values()].find((s) => s.name === name),
    setStatus(id, status) {
      const s = sessions.get(id);
      if (s) s.status = status;
    },
    setSdkSessionId(id, sdkSessionId) {
      const s = sessions.get(id);
      if (s) s.sdkSessionId = sdkSessionId;
    },
    touch(id, now = Date.now()) {
      const s = sessions.get(id);
      if (s) s.lastActivityAt = now;
    },
  };
}
