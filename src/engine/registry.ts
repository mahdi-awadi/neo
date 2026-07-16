// Tracks the live worker sessions the engine is driving (in-process SDK handles).
// Unlike operant's session-registry (built for external processes reconnecting over a
// socket), these sessions are owned by the engine — no reconnect/ghost-slot logic.
// Keyed by the stable order id; addressable by short name (for /kill) and by chat (for
// follow-up routing). The unique-name scheme is ported from operant, trimmed.
import { basename } from "node:path";
import type { Order, SessionControl, SessionInfo } from "../types";

/** Statuses for a session that is still live (followable / killable). */
const OPEN: ReadonlySet<SessionInfo["status"]> = new Set(["running", "idle"]);

/** How long a chat's focus on a project lasts. `once` reverts to the company after ONE delivered
 *  message (the operator's default — stops stray messages sticking to a project); `pinned` holds
 *  until it's cleared (an explicit multi-turn conversation). See docs/superpowers/specs/…focus…. */
export type FocusMode = "once" | "pinned";

export interface Registry {
  /** Register a freshly-started session. Returns the created entry (name may be uniquified). */
  add(order: Order, now?: number): SessionInfo;
  get(id: string): SessionInfo | undefined;
  list(): SessionInfo[];
  remove(id: string): void;
  /** The follow-up target for a chat: the currently-focused session if still OPEN, else undefined
   * (so callers fall back to the company/default — the default target is never a stray project). */
  findByChat(chatId: number): SessionInfo | undefined;
  /** Focus the project a chat's next follow-up(s) route to. `once` = revert to the company after
   * one delivered message; `pinned` = stay until clearFocus. Replaces the old sticky `setActive`. */
  setFocus(chatId: number, id: string, mode: FocusMode): void;
  /** Drop a chat's focus, reverting it to the company/default target. */
  clearFocus(chatId: number): void;
  /** A chat's current focus (session + mode) while the focused session is still OPEN, else undefined. */
  getFocus(chatId: number): { session: SessionInfo; mode: FocusMode } | undefined;
  findByName(name: string): SessionInfo | undefined;
  /** The most-recently-active OPEN session for a folder (so dispatch reuses it, not a duplicate). */
  findByFolder(folder: string): SessionInfo | undefined;
  setStatus(id: string, status: SessionInfo["status"]): void;
  setSdkSessionId(id: string, sdkSessionId: string): void;
  touch(id: string, now?: number): void;
  /** Attach the live control handle so follow-up / kill / idle-close can reach it. */
  attachControl(id: string, control: SessionControl): void;
  /** Drop the control handle when a run ends, keeping the session (now resumable, not live). */
  detachControl(id: string): void;
  getControl(id: string): SessionControl | undefined;
  /** Mark the always-on default project — the fallback target for free-text with no active session. */
  setDefault(id: string): void;
  /** The default project if it's still registered (else undefined). */
  getDefault(): SessionInfo | undefined;
  /** Record what the session is doing right now; `since` is kept while the label is unchanged. */
  noteActivity(id: string, label: string, now?: number): void;
  /** Stamp the last stuck-alert time (watchdog dedup). */
  noteAlert(id: string, now?: number): void;
}

export function createRegistry(): Registry {
  const sessions = new Map<string, SessionInfo>();
  const controls = new Map<string, SessionControl>();
  const focus = new Map<number, { id: string; mode: FocusMode }>(); // chatId -> focused project
  let defaultId: string | undefined; // the always-on default project (fallback target)

  function uniqueName(base: string): string {
    const taken = new Set([...sessions.values()].map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Resolve a chat's focus to its live session (+ mode), or undefined once it closes / isn't set. */
  function resolveFocus(chatId: number): { session: SessionInfo; mode: FocusMode } | undefined {
    const f = focus.get(chatId);
    if (!f) return undefined;
    const session = sessions.get(f.id);
    if (!session || !OPEN.has(session.status)) return undefined; // closed → no focus
    return { session, mode: f.mode };
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
    attachControl(id, control) {
      // Defensive against F5: /kill during a pending gate can remove the session before the
      // (possibly async) caller reaches attachControl. Storing it then would leak an orphan
      // control no one will ever detach/interrupt via the registry again.
      if (!sessions.has(id)) {
        void control.interrupt?.();
        return;
      }
      controls.set(id, control);
    },
    detachControl: (id) => void controls.delete(id),
    getControl: (id) => controls.get(id),
    setDefault: (id) => void (defaultId = id),
    getDefault: () => (defaultId ? sessions.get(defaultId) : undefined),
    findByChat: (chatId) => resolveFocus(chatId)?.session,
    setFocus: (chatId, id, mode) => void focus.set(chatId, { id, mode }),
    clearFocus: (chatId) => void focus.delete(chatId),
    getFocus: (chatId) => resolveFocus(chatId),
    findByName: (name) => [...sessions.values()].find((s) => s.name === name),
    findByFolder: (folder) =>
      [...sessions.values()]
        .filter((s) => s.order.folder === folder && OPEN.has(s.status))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0],
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
    noteActivity(id, label, now = Date.now()) {
      const s = sessions.get(id);
      if (!s) return;
      if (s.activity?.label !== label) s.activity = { label, since: now };
    },
    noteAlert(id, now = Date.now()) {
      const s = sessions.get(id);
      if (s) s.alertedAt = now;
    },
  };
}
