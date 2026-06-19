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
  | { escalate: string };

/** A live worker session the engine is driving (an in-process SDK handle). */
export interface SessionInfo {
  /** SDK session id (used for resume/fork). */
  id: string;
  order: Order;
  status: "running" | "idle" | "done" | "error";
  startedAt: number;
}
