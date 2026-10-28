// Side lanes (ADR-0057): small, independent todos run beside a project's main task. The chief of
// staff picks the lane and kind when it writes the brief; this module holds the rules the engine
// enforces with them — the kinds, the config, the start check and the governor's lane verdict.
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

/** What a side-lane todo declares it does (CONTEXT.md "Lane kind"). */
export const LANE_KINDS = ["read-only", "ops", "test", "code"] as const;
export type LaneKind = (typeof LANE_KINDS)[number];

export function isLaneKind(x: unknown): x is LaneKind {
  return typeof x === "string" && (LANE_KINDS as readonly string[]).includes(x);
}

/** A todo's lane: the project's one main session, or a side lane of a declared kind. */
export type Lane = { lane: "main" } | { lane: "side"; kind: LaneKind };

/** A live side-lane session's marker (SessionInfo.lane). `projectFolder` is the project the lane
 *  belongs to — for `code` the session's own folder is its worktree. */
export interface SessionLane {
  kind: LaneKind;
  projectFolder: string;
  todoId?: number;
}

/** The `lanes` config block (docs/CONFIG.md). */
export interface LanesCfg {
  /** false → every brief goes to the queue, as before ADR-0057. */
  enabled: boolean;
  /** Side lanes one project may run at once. 0 = none. */
  maxSidePerProject: number;
  /** Dispatch runs (main and side) the host may run at once before a side lane waits. */
  maxDispatchesHost: number;
  /** Where `code` lanes get their temporary worktrees (absolute; outside the work root). */
  worktreeRoot: string;
  /** How a brief with no lane is placed. Only "none" (the queue) in v1; reserved for a classifier. */
  noLaneClassifier: "none";
}

export const DEFAULT_LANES_CFG: LanesCfg = {
  enabled: true,
  maxSidePerProject: 1,
  maxDispatchesHost: 3,
  worktreeRoot: join(tmpdir(), "neo-lanes"),
  noLaneClassifier: "none",
};

/** Parse the config value; a missing or bad field keeps its default. */
export function readLanesCfg(raw: unknown): LanesCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const count = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_LANES_CFG.enabled,
    maxSidePerProject: count(r.maxSidePerProject, 0) ? r.maxSidePerProject : DEFAULT_LANES_CFG.maxSidePerProject,
    maxDispatchesHost: count(r.maxDispatchesHost, 1) ? r.maxDispatchesHost : DEFAULT_LANES_CFG.maxDispatchesHost,
    worktreeRoot: typeof r.worktreeRoot === "string" && isAbsolute(r.worktreeRoot) ? r.worktreeRoot : DEFAULT_LANES_CFG.worktreeRoot,
    noLaneClassifier: "none",
  };
}
