// Shared types for the Neo engine.
import type { SessionLane } from "./engine/lanes";
import type { BlockedOn } from "./engine/liveness";
import type { Cause } from "./engine/ledger";

export type { BlockedOn };

/** Where an order originated. Drives provider routing (the compliance firewall). */
export type OrderSource = "neo" | "customer";

/**
 * Which brain executes an order. Config-driven (see provider-router + config).
 * "subscription" = Claude Agent SDK on your Claude plan; "codex" = OpenAI Codex SDK;
 * "gemini" = Gemini API.
 */
export type Provider = "subscription" | "codex" | "gemini";

/** A unit of work handed to the engine. */
export interface Order {
  id: string;
  source: OrderSource;
  /** Absolute path to the project folder the worker opens (`cwd` for the SDK). */
  folder: string;
  /** Natural-language instruction for the worker. */
  task: string;
  /** Channel address to stream results back to (e.g. Telegram chat id). */
  chatId: number;
  createdAt: number;
}

/** Provider-router decision: either a chosen provider or a refusal with a reason. */
export type RouteResult = { provider: Provider } | { refuse: string };

/** What a sent channel message maps back to, so a REPLY to it routes into the right project.
 *  Persisted in the ledger (survives reload) and cached in memory; `folder` is the stable key
 *  (a session id changes across idle-close, the folder does not). */
export interface RouteTarget {
  /** The registry/session id that produced the message (best-effort — may be gone after a close). */
  sessionId: string;
  /** Absolute project folder — the durable anchor used to re-find or resume the session. */
  folder: string;
  /** Short project name (folder basename) used for focus + display. */
  project: string;
}

/**
 * Governor decision for a single tool request from the worker.
 * `allow` may rewrite the tool input; `escalate` hands the decision to a human.
 */
export type Verdict =
  | { allow: true; updatedInput?: Record<string, unknown> }
  /** `fenced`: a fence escalation — only the operator may approve it, never trust (ADR-0011). */
  | { escalate: string; fenced?: true }
  | { deny: string };

/**
 * The live control surface of a running session, held by the registry so that
 * follow-up routing, `/kill`, and idle-close can all reach the same handle.
 * `SessionRun` (session-runner) is the concrete implementation.
 */
/** When a follow-up reaches a busy worker: "steer" = at its next step mid-turn (the operator's own
 *  words), "after-turn" = only once the in-flight turn ends (engine briefs and nudges that must not
 *  hijack it). REQUIRED on every `followUp` so no caller picks one by accident (ADR-0050 §5). */
export type FollowUpTiming = "steer" | "after-turn";

export interface SessionControl {
  /** Push a brief to the worker with an explicit `timing`. `cause`: the operator message it carries
   *  (ADR-0015) — the pipeline's control files it in turn order; a control that does not trace ignores it. */
  followUp(text: string, timing: FollowUpTiming, cause?: Cause): void;
  /** True when a "steer" follow-up reaches the worker at its next step mid-turn (Claude); absent/false
   *  when it waits for the current turn to finish (Codex runs one turn per input). */
  steersMidTurn?: boolean;
  interrupt(): Promise<void>;
  /** Gracefully stop accepting input after draining already accepted turns. */
  close?(): void;
  /** Drain accepted work before switching the platform SDK. */
  switchProvider?(): void;
  /** Follow-ups waiting behind the in-flight turn (observability; optional for old fakes). */
  queued?(): number;
  /** True while a turn is being processed RIGHT NOW, as opposed to the session sitting idle
   *  between turns. A live session's registry `status` stays "running" for its whole lifetime (it
   *  flips back to "idle" only when the whole run ends), so status alone cannot tell a worker
   *  mid-turn from one waiting for the next brief — this is the signal that can. Optional for old
   *  fakes (absent → treated as not-active, i.e. idle). */
  active?(): boolean;
  /** True once the input channel was closed (graceful close or interrupt): a follow-up pushed now
   *  is dropped, so a caller must refuse to deliver instead. Optional for old fakes (absent → open). */
  closed?(): boolean;
  /** The path of the big plan the worker is held at (ADR-0036), else undefined. A held worker denies
   *  every tool but reads, so a brief delivered now could only be answered with STOP: a caller must
   *  not deliver one (ADR-0052). Optional for old fakes (absent → not held). */
  held?(): string | undefined;
  /** The running tool calls and their controls (ADR-0058). Absent on fakes and old handles. */
  tools?: ToolCalls;
}

/** One session's running tool calls and the SDK controls over them (ADR-0058). Claude: the SDK's
 *  backgroundTasks/stopTask. Codex: no per-call control — `stop` ends the current turn. */
export interface ToolCalls {
  provider: "claude" | "codex";
  running(): Array<{ toolUseId: string; tool: string; summary: string; since: number; taskId?: string }>;
  background(toolUseId: string): Promise<{ ok: boolean; taskId?: string; reason?: string }>;
  stop(toolUseId: string): Promise<{ ok: boolean; taskId?: string; reason?: string }>;
  /** The log file of a backgrounded call, once the SDK named it. */
  logOf?(toolUseId: string): string | undefined;
}

/** A live worker session the engine is driving (an in-process SDK handle). */
export interface SessionInfo {
  /** A side-lane session (ADR-0057): never the folder's main session. Absent = the main lane. */
  lane?: SessionLane;
  /** A customer-driven run (an ingress brief's dispatch) used this session (ADR-0061): it stays fenced,
   *  and the chief of staff's `project_message` never speaks into it. */
  customerDriven?: true;
  /** Stable engine key — the order id, known from registration (before the SDK id exists). */
  id: string;
  /** Short, unique, human-facing name (folder basename) for `/status` and `/kill`. */
  name: string;
  /** SDK session id (used for resume/fork). Empty until the first message arrives. */
  sdkSessionId: string;
  /** Which SDK minted `sdkSessionId`. A session id is only meaningful to its own SDK, so a resume
   *  under a different worker SDK (`/sdk claude` after a Codex run) must start fresh instead. */
  sdkProvider?: Provider;
  order: Order;
  /** LIFECYCLE of this registry entry — `running` while a run is open, `idle` once it ends. NOT
   *  what the worker is doing: it stays `running` for the session's whole life, including while it
   *  sits between turns. Never report it to the operator; report `sessionState()` (liveness.ts). */
  status: "running" | "idle" | "done" | "error";
  startedAt: number;
  /** THE authoritative liveness clock: the last time ANY worker activity was seen — every streamed
   *  SDK event, including partial generation deltas that produce no operator-visible line. Wedged /
   *  stall / idle-close decisions read this and nothing else (docs/adr/0003-…). */
  lastActivityAt: number;
  /** Last time the worker produced operator-VISIBLE output. Reported, never judged — a worker can
   *  be busy for an hour without saying anything. Absent on entries that never emitted. */
  lastOutputAt?: number;
  /** What the worker is doing right now (last tool/text), for /status + the stuck-watchdog. NOTE
   *  `since` is the age of this LABEL, not of the session's last sign of life — never judge on it. */
  activity?: { label: string; since: number };
  /** Set while the operator owes this session an answer (a permission escalation or a raised
   *  decision). Such a session is never wedged and is never stall-aborted. */
  blockedOn?: BlockedOn;
  /** Set while a dispatch repeats itself with nothing changing (spec §8.1): the same digest
   *  fingerprint or the same tool call over and over. Cleared when its fingerprint changes. */
  spinning?: { label: string; since: number };
  /** Last time the stuck-watchdog alerted about this session (dedup). */
  alertedAt?: number;
}
