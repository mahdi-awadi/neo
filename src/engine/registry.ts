// Tracks the live worker sessions the engine is driving (in-process SDK handles).
// Unlike operant's session-registry (built for external processes reconnecting over a
// socket), these sessions are owned by the engine — no reconnect/ghost-slot logic.
// Keyed by the stable order id; addressable by short name (for /kill) and by chat (for
// follow-up routing). The unique-name scheme is ported from operant, trimmed.
import { basename } from "node:path";
import type { Cause } from "./ledger";
import type { BlockedOn, Order, Provider, SessionControl, SessionInfo } from "../types";

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
  /** Record the live SDK session id and (when known) WHICH SDK minted it, so a later resume never
   *  hands a Codex thread id to Claude or vice versa. */
  setSdkSessionId(id: string, sdkSessionId: string, provider?: Provider): void;
  touch(id: string, now?: number): void;
  /** Liveness pulse: ANY streamed worker event. Advances the authoritative activity clock and
   *  nothing else — the label is left alone, so "what is it doing" stays meaningful while
   *  "is it alive" stays fresh. This is the ONLY signal wedged/stall/idle decisions read. */
  noteHeartbeat(id: string, now?: number): void;
  /** The worker produced an operator-VISIBLE line. Advances the output clock AND the activity
   *  clock (output is activity); the reverse is deliberately not true. */
  noteOutput(id: string, now?: number): void;
  /** Record (or clear, with `undefined`) what the operator owes this session. While set, the
   *  session is awaiting-operator: never wedged, never stall-aborted. */
  noteBlocked(id: string, blocked: BlockedOn | undefined): void;
  /** Mark (or clear) a session that repeats itself with nothing changing (spec §8.1). */
  noteSpinning(id: string, mark: { label: string; since: number } | undefined): void;
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
  /** One input was delivered to this session (a brief pushed, or a run started), with the cause of
   *  the operator message it carries — none for engine input (a dispatcher report, a wrap-up). Inputs
   *  keep their order, so a runner that reports what a turn consumed (startTurn) lines up with them. */
  deliver(id: string, cause?: Cause): void;
  /** `deliver` for an input that has a cause. */
  setCause(id: string, cause: Cause): void;
  /** A turn started and took the next `n` waiting inputs (the Codex loop takes one per turn). A
   *  runner that cannot tell (the Claude SDK pulls input eagerly) never calls this. */
  startTurn(id: string, n: number): void;
  /** The cause output is attributed to (spec §4.2): the newest cause the current turn consumed; when
   *  no runner reported a turn start, the newest delivered cause whose turn has not ended. */
  causeOf(id: string): Cause | undefined;
  /** Every delivered cause not yet answered, oldest first — the session's open work (spec §5). */
  pendingCauses(id: string): Cause[];
  /** The turn ended: the causes it consumed are answered (all delivered ones when no turn start was
   *  reported, or with `all` — the run is over). Returns them, oldest first, and drops them. */
  endTurn(id: string, opts?: { all?: boolean }): Cause[];
  /** The newest cause a turn took or answered, kept after the turn ended: lines after the turn (the
   *  run's final result) and the reload snapshot (spec §11.3) are filed under it. */
  lastCauseOf(id: string): Cause | undefined;
  /** Boot restore (spec §11.3): the session has no live cause, but its next output is filed under this. */
  restoreCause(id: string, cause: Cause): void;
  /** Stamp the last stuck-alert time (watchdog dedup). */
  noteAlert(id: string, now?: number): void;
}

export function createRegistry(): Registry {
  const sessions = new Map<string, SessionInfo>();
  const controls = new Map<string, SessionControl>();
  const focus = new Map<number, { id: string; mode: FocusMode }>(); // chatId -> focused project
  // session id -> inputs delivered and not yet answered, in order; `consumed` = taken by the current turn
  const inputs = new Map<string, Array<{ cause?: Cause; consumed: boolean }>>();
  const lastCauses = new Map<string, Cause>(); // session id -> newest cause a turn took or answered
  const newest = (list: Array<{ cause?: Cause }>): Cause | undefined => list.findLast((x) => x.cause)?.cause;
  const deliver = (id: string, cause?: Cause): void => {
    const list = inputs.get(id);
    if (list) list.push({ cause, consumed: false });
    else inputs.set(id, [{ cause, consumed: false }]);
  };
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
        lastOutputAt: now,
      };
      sessions.set(session.id, session);
      return session;
    },
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
    remove: (id) => {
      sessions.delete(id);
      controls.delete(id);
      inputs.delete(id);
      lastCauses.delete(id);
    },
    deliver,
    setCause: (id, cause) => deliver(id, cause),
    startTurn(id, n) {
      const waiting = (inputs.get(id) ?? []).filter((x) => !x.consumed).slice(0, n);
      for (const x of waiting) x.consumed = true;
      const took = newest(waiting);
      if (took) lastCauses.set(id, took);
    },
    causeOf(id) {
      const list = inputs.get(id) ?? [];
      const consumed = list.filter((x) => x.consumed);
      return newest(consumed.length > 0 ? consumed : list);
    },
    pendingCauses: (id) => (inputs.get(id) ?? []).flatMap((x) => (x.cause ? [x.cause] : [])),
    endTurn(id, opts) {
      const list = inputs.get(id) ?? [];
      const all = opts?.all === true || !list.some((x) => x.consumed);
      const answered = all ? list : list.filter((x) => x.consumed);
      const rest = all ? [] : list.filter((x) => !x.consumed);
      if (rest.length > 0) inputs.set(id, rest);
      else inputs.delete(id);
      const last = newest(answered);
      if (last) lastCauses.set(id, last);
      return answered.flatMap((x) => (x.cause ? [x.cause] : []));
    },
    lastCauseOf: (id) => lastCauses.get(id),
    restoreCause: (id, cause) => void lastCauses.set(id, cause),
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
    setSdkSessionId(id, sdkSessionId, provider) {
      const s = sessions.get(id);
      if (!s) return;
      s.sdkSessionId = sdkSessionId;
      // Clearing the id (context-policy handoff) clears its owner too — a provider left behind on
      // an empty id would claim ownership of the NEXT SDK's session.
      s.sdkProvider = sdkSessionId ? (provider ?? s.sdkProvider) : undefined;
    },
    touch(id, now = Date.now()) {
      const s = sessions.get(id);
      if (s) s.lastActivityAt = now;
    },
    noteHeartbeat(id, now = Date.now()) {
      const s = sessions.get(id);
      if (s) s.lastActivityAt = now;
    },
    noteOutput(id, now = Date.now()) {
      const s = sessions.get(id);
      if (!s) return;
      s.lastOutputAt = now;
      s.lastActivityAt = now;
    },
    noteBlocked(id, blockedOn) {
      const s = sessions.get(id);
      if (s) s.blockedOn = blockedOn;
    },
    noteSpinning(id, mark) {
      const s = sessions.get(id);
      if (s) s.spinning = mark;
    },
    noteActivity(id, label, now = Date.now()) {
      const s = sessions.get(id);
      if (!s) return;
      // A tool call IS a sign of life, even when it repeats the previous label — the clock must
      // move even though `since` (the age of the LABEL) deliberately does not.
      s.lastActivityAt = now;
      if (s.activity?.label !== label) s.activity = { label, since: now };
    },
    noteAlert(id, now = Date.now()) {
      const s = sessions.get(id);
      if (s) s.alertedAt = now;
    },
  };
}
