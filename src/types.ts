// Shared types for the Neo engine.

/** Where an order originated. Drives provider routing (the compliance firewall). */
export type OrderSource = "neo" | "customer";

/**
 * Which brain executes an order. Config-driven (see provider-router + config).
 * "subscription" = Claude Agent SDK on your Claude plan; "gemini" = Gemini API.
 */
export type Provider = "subscription" | "gemini";

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

/**
 * Governor decision for a single tool request from the worker.
 * `allow` may rewrite the tool input; `escalate` hands the decision to a human.
 */
export type Verdict =
  | { allow: true; updatedInput?: Record<string, unknown> }
  | { escalate: string }
  | { deny: string };

/**
 * The live control surface of a running session, held by the registry so that
 * follow-up routing, `/kill`, and idle-close can all reach the same handle.
 * `SessionRun` (session-runner) is the concrete implementation.
 */
export interface SessionControl {
  followUp(text: string): void;
  interrupt(): Promise<void>;
}

/** A live worker session the engine is driving (an in-process SDK handle). */
export interface SessionInfo {
  /** Stable engine key — the order id, known from registration (before the SDK id exists). */
  id: string;
  /** Short, unique, human-facing name (folder basename) for `/status` and `/kill`. */
  name: string;
  /** SDK session id (used for resume/fork). Empty until the first message arrives. */
  sdkSessionId: string;
  order: Order;
  status: "running" | "idle" | "done" | "error";
  startedAt: number;
  /** Last time the worker produced output or took input — drives idle-close. */
  lastActivityAt: number;
}
