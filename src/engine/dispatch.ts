// The `dispatch` tool — given ONLY to the default project ("the company"). It lets the
// chief-of-staff open one of the operator's projects and run a self-contained brief in it, as a
// tracked, governed Neo sub-project (registry → dashboard, escalations → operator, metered),
// then returns that project's result for the company to summarise. The company writes the brief
// (a tailored prompt), so the sub-project gets a clear order, not the operator's raw message.
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Order, SessionInfo } from "../types";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { Meter } from "./budget";
import type { UsageMeter } from "./usage";
import type { TrustStore } from "./trust";
import { runOrder, startOrder, type RunResult } from "./session-runner";
import { DEFAULT_PROJECT } from "./default-project";
import { decideContext, sessionContext, runHandoff, type ContextPolicyCfg } from "./context-policy";

/** Reserved chat id for dispatched sub-projects, so they never hijack the operator's free-text
 *  routing (which always falls back to the default project). */
export const SUB_CHAT = -2;

/** Function-scoped scratch workspaces (research, dev, marketing, …) for work with no project home. */
export const DESKS_DIR = join(DEFAULT_PROJECT.folder, "desks");

/** Everything dispatch needs — a structural subset of the pipeline's deps. */
export interface DispatchDeps {
  ledger: Ledger;
  registry: Registry;
  meter: Meter;
  usage?: UsageMeter;
  trust: TrustStore;
  reply: (chatId: number, text: string, project?: string) => void | Promise<void>;
  askApproval: (chatId: number, reason: string) => Promise<"allow" | "deny">;
  /** Deliver a worker-produced file back to the operator's channel (Telegram/web). */
  sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void>;
  /** Default per-dispatch ceiling (ms) when the caller doesn't request one. Default DISPATCH_TIMEOUT_MS_DEFAULT. */
  dispatchTimeoutMs?: number;
  /** Hard cap (ms) on any caller-requested ceiling. Default DISPATCH_TIMEOUT_MAX_MS_DEFAULT (2h). */
  dispatchTimeoutMaxMs?: number;
  /** Abort a sub-run with NO activity for this long (ms) — a busy worker stays alive up to the
   *  ceiling. Default DISPATCH_STALL_MS_DEFAULT (5m). */
  dispatchStallMs?: number;
  /** Grace window (ms): on a limit, tell the worker to commit green work + write a WIP note,
   *  then hard-abort. Default DISPATCH_GRACE_MS_DEFAULT (75s). */
  dispatchGraceMs?: number;
  /** When set, gate dispatch's session reuse through the same context policy the interactive
   *  pipeline uses — a resumed sub-project session must not grow unbounded (see
   *  docs/superpowers/specs/2026-07-08-context-policy-design.md, Boundaries #3). */
  contextPolicy?: ContextPolicyCfg;
  /** Graceful-reload gate: while draining, dispatch refuses new sub-runs (see engine/reload.ts). */
  lifecycle?: { draining(): boolean };
}

type RunFn = typeof runOrder;

/** Default per-dispatch ceiling (ms) — 15 minutes. */
export const DISPATCH_TIMEOUT_MS_DEFAULT = 900_000;
/** Hard cap on any caller-requested ceiling (ms) — 2 hours. */
export const DISPATCH_TIMEOUT_MAX_MS_DEFAULT = 7_200_000;
/** Liveness stall limit (ms) — 5 minutes of NO activity aborts a sub-run. */
export const DISPATCH_STALL_MS_DEFAULT = 300_000;
/** Wrap-up grace window (ms) — 75 seconds between the limit firing and the hard abort. */
export const DISPATCH_GRACE_MS_DEFAULT = 75_000;

/**
 * Resolve a project reference to a folder: an absolute path, else a repo under `root` (/home),
 * else a desk under `desks` (the agent's function workspaces). A real project wins over a
 * same-named desk.
 */
/** True when `folder` resolves to (or inside) one of the allowed roots. The deterministic guard
 *  that keeps a dispatch target under /home (+ the agent's desks) — never an out-of-tree absolute
 *  path (/etc, /root, …) or a `..` traversal that escapes the project root. */
function containedInAny(folder: string, roots: string[]): boolean {
  const f = resolve(folder);
  return roots.some((r) => {
    const rr = resolve(r);
    return f === rr || f.startsWith(rr + sep);
  });
}

export function resolveProject(project: string, root = "/home", desks = DESKS_DIR): string | undefined {
  const candidates = project.startsWith("/") ? [project] : [join(root, project), join(desks, project)];
  for (const c of candidates) {
    try {
      // Must be a real directory AND contained under an allowed root — so the company can only
      // dispatch into the operator's projects/desks, never an arbitrary absolute path.
      if (existsSync(c) && statSync(c).isDirectory() && containedInAny(c, [root, desks])) return c;
    } catch {
      // ignore and try the next candidate
    }
  }
  return undefined;
}

/** Only CLAUDE.md auto-loads into a worker (verified 2026-07-08) — AGENTS.md, DESIGN.md and the
 *  rest of a project's rule/docs .md files never reach it unless the brief says so. Every
 *  dispatched brief gets this preamble so the worker reads its own rules before acting. */
export function briefWithProjectDocs(task: string): string {
  return (
    "Before starting, read this project's rule and doc .md files so you work by its rules: " +
    "AGENTS.md, DESIGN.md, and any other root-level .md files (besides CLAUDE.md, already loaded), " +
    "plus the docs relevant to this task (e.g. under docs/). Follow them together with CLAUDE.md.\n\n" +
    task
  );
}

/**
 * Open `project` as a tracked Neo sub-project, run `task` to completion (single-shot), streaming
 * its output to the operator tagged with the project name and escalating risky tools to them, then
 * return the project's final result text. Kept as an idle entry afterwards (resumable; the idle
 * watchdog or /kill removes it).
 */
export async function dispatchToProject(
  project: string,
  task: string,
  deps: DispatchDeps,
  replyChat: number,
  opts: {
    start?: typeof startOrder;
    run?: RunFn;
    now?: () => number;
    root?: string;
    desks?: string;
    /** Test seams for the context policy (default: real transcript measurement + handoff run). */
    signals?: typeof sessionContext;
    handoff?: typeof runHandoff;
    /** Caller-requested per-dispatch ceiling (ms) — clamped to dispatchTimeoutMaxMs. */
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const now = opts.now ?? (() => Date.now());
  if (deps.lifecycle?.draining()) {
    return "Neo is reloading — dispatch refused; retry after the restart (open sessions are preserved).";
  }
  const folder = resolveProject(project, opts.root, opts.desks);
  if (!folder) return `No project or desk named "${project}" was found — check the name.`;

  const order: Order = {
    id: crypto.randomUUID(),
    source: "neo",
    folder,
    task: briefWithProjectDocs(task),
    chatId: SUB_CHAT,
    createdAt: now(),
  };
  deps.ledger.recordOrder(order);
  // Reuse an already-open session for this folder (resume it) instead of duplicating it as
  // "<name>-2"; only register a fresh entry when nothing is open for the folder.
  const existing = deps.registry.findByFolder(folder);
  const wasRunning = existing?.status === "running";
  const session = existing ?? deps.registry.add(order, now());
  const name = session.name;
  // Busy guard: never stack a second run onto a folder whose session is mid-turn.
  if (existing && wasRunning) {
    return `${name} is still busy with the previous dispatch — its result will arrive when it finishes.`;
  }
  if (existing) {
    deps.registry.setStatus(existing.id, "running");
    deps.registry.touch(existing.id, now());
  }
  await deps.reply(replyChat, `→ dispatching to ${name}: ${task}`, name);

  const resume = existing?.sdkSessionId || deps.ledger.lastSessionFor(folder, SUB_CHAT) || undefined;
  const start = opts.start ?? startOrder;
  // Per-dispatch ceiling: the caller (the company knows if this is a 2-minute lookup or a
  // 2-hour build) may request one, hard-capped so a dispatch can never run unbounded.
  const maxMs = deps.dispatchTimeoutMaxMs ?? DISPATCH_TIMEOUT_MAX_MS_DEFAULT;
  const ceilingMs = Math.min(opts.timeoutMs ?? deps.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS_DEFAULT, maxMs);
  const stallMs = deps.dispatchStallMs ?? DISPATCH_STALL_MS_DEFAULT;
  const graceMs = deps.dispatchGraceMs ?? DISPATCH_GRACE_MS_DEFAULT;

  // Background continuation: bounded await, then bookkeeping + report-back. NEVER awaited here —
  // the company's turn ends immediately (operator requirement: the main agent is always free).
  // The context-policy gate + start(...) + attachControl also live in here (not before it) so
  // the gate's occasional real await (the "handoff" verdict runs a bounded worker turn) never
  // delays the string this function returns to the calling company session.
  void (async () => {
    let gatedResume = resume;
    if (gatedResume && deps.contextPolicy) {
      try {
        const signals = opts.signals ?? sessionContext;
        const sig = signals(folder, gatedResume);
        const verdict = decideContext(sig, deps.contextPolicy);
        if (verdict === "clear") {
          gatedResume = undefined;
          deps.ledger.clearSessionsFor(folder);
          deps.ledger.recordContextEvent(folder, "clear", sig.occupancy);
        } else if (verdict === "handoff") {
          const handoff = opts.handoff ?? runHandoff;
          const target: SessionInfo = { ...session, sdkSessionId: session.sdkSessionId || gatedResume };
          await handoff(target, deps.contextPolicy, { registry: deps.registry, ledger: deps.ledger });
          gatedResume = undefined;
        }
        // "keep" leaves gatedResume unchanged.
      } catch {
        // context-policy is best-effort observer work — fail OPEN, keep the original resume id.
      }
    }

    const startedAt = now();
    let lastActivityAt = startedAt;
    const run = start(
      order,
      {
        onMessage: (t) => {
          lastActivityAt = now();
          void deps.reply(replyChat, t, name);
        },
        onEscalation: (reason) => deps.askApproval(replyChat, reason),
        onRateLimit: (info) => deps.usage?.noteRateLimit(info),
        autoApprove: () => deps.trust.isTrusted(folder),
        onAutoApprove: (reason) => {
          deps.ledger.recordAutoApproval(order.id, reason);
          void deps.reply(replyChat, `🔓 auto-approved: ${reason}`, name);
        },
        onActivity: (label) => {
          lastActivityAt = now();
          try {
            deps.registry.noteActivity(session.id, label, now());
            deps.registry.touch(session.id, now());
          } catch {
            /* observer only */
          }
        },
      },
      { resume: gatedResume },
    );
    deps.registry.attachControl(session.id, run);

    // Liveness monitor: the timeout protects against a HUNG worker, not a busy one. A dispatch
    // is aborted when the sub-run has produced no activity for stallMs, OR when the per-dispatch
    // ceiling is hit — a worker streaming output for 90 minutes stays alive (up to the ceiling).
    const sleep = (ms: number) => new Promise<"tick">((res) => setTimeout(() => res("tick"), ms));
    const doneOrTick = (ms: number) => Promise.race([run.done.then((r) => ({ done: r })), sleep(ms)]);
    const checkMs = Math.max(1, Math.floor(Math.min(stallMs, ceilingMs) / 4));
    let result: RunResult;
    let timedOut = false;
    try {
      let limit: "stall" | "ceiling" | undefined;
      for (;;) {
        const settled = await doneOrTick(checkMs);
        if (settled !== "tick") {
          result = settled.done;
          break;
        }
        const t = now();
        if (t - startedAt >= ceilingMs) limit = "ceiling";
        else if (t - lastActivityAt >= stallMs) limit = "stall";
        if (!limit) continue;
        // Graceful wrap-up: give the worker a short grace window to commit green work and leave
        // a WIP note (the commit-per-task recovery we used to do by hand), then hard-abort.
        run.followUp(
          `⏱ Neo dispatch ${limit === "stall" ? "stall" : "time"} limit reached — stop working now. ` +
            `Commit any green work and write a brief WIP note (plan doc or WIP.md) so a follow-up run can resume. ` +
            `You have ~${Math.round(graceMs / 1000)}s before this session is aborted.`,
        );
        const graced = await doneOrTick(graceMs);
        if (graced !== "tick") {
          result = graced.done; // wrapped up in time — keep the worker's own result
          break;
        }
        timedOut = true;
        await run.interrupt();
        const detail =
          limit === "stall"
            ? `no activity for ${Math.round(stallMs / 60000)}m (stall limit)`
            : `hit the ${Math.round(ceilingMs / 60000)}m dispatch ceiling`;
        result = { ok: false, sessionId: "", summary: `timed out: ${detail} — asked to wrap up, then aborted`, costUsd: 0 };
        break;
      }
    } catch (e) {
      result = { ok: false, sessionId: "", summary: e instanceof Error ? e.message : String(e), costUsd: 0 };
    }
    try {
      if (result.sessionId) {
        deps.registry.setSdkSessionId(session.id, result.sessionId);
        deps.ledger.recordSession(order.id, result.sessionId);
      }
      deps.meter.note({ costUsd: result.costUsd }, now());
      deps.ledger.recordOutcome(order.id, result.ok ? "done" : "error", result.summary);
      if (timedOut || !result.ok) {
        // A dead run must not linger: an "error" session is invisible to findByFolder (never
        // reused) and to sweepIdle (never reaped), so it would sit as a zombie and force the next
        // dispatch to register "<name>-2", "-3", … Remove it; the ledger keeps the error outcome,
        // and any sdkSessionId was persisted above for resume.
        deps.registry.remove(session.id);
      } else {
        deps.registry.setStatus(session.id, "idle");
        deps.registry.touch(session.id, now());
        deps.registry.detachControl(session.id);
      }
      const line = result.ok ? `✅ ${name} finished: ${result.summary || "done"}` : `⛔ ${name}: ${result.summary || "failed"}`;
      await deps.reply(replyChat, line, name);
      // Feed the result back into the live company session so it can act on it next turn.
      const company = deps.registry.getDefault();
      const control = company && company.id !== session.id ? deps.registry.getControl(company.id) : undefined;
      control?.followUp(`[dispatch result] ${name}: ${result.summary || (result.ok ? "done" : "failed")}`);
    } catch {
      // observer/bookkeeping errors must not surface into the worker path
    }
  })();

  return `dispatched to ${name} — running in the background; its output streams to the operator and you will receive its result as a follow-up message when it finishes.`;
}

/** Send a file the worker produced, but only if `path` is inside `folder`. Returns a status string. */
export async function sendProjectFile(
  deps: { sendFile?: (chatId: number, path: string, caption?: string) => void | Promise<void> },
  chatId: number,
  folder: string,
  path: string,
  caption?: string,
): Promise<string> {
  let root: string;
  try {
    root = realpathSync(resolve(folder));
  } catch {
    return `refused: project folder does not exist`;
  }
  // Lexical pre-check: reject obvious traversal before touching the filesystem.
  const lexAbs = resolve(folder, path);
  if (lexAbs === root || !lexAbs.startsWith(root + sep)) return `refused: ${path} is outside project`;
  // Symlink-safe check: resolve symlinks for existing paths and re-verify confinement.
  let abs: string;
  try {
    abs = realpathSync(lexAbs);
  } catch {
    return `not found: ${path}`;
  }
  if (abs === root || !abs.startsWith(root + sep)) return `refused: ${path} is outside project`;
  if (!statSync(abs).isFile()) return `refused: ${path} is not a regular file`;
  await deps.sendFile?.(chatId, abs, caption);
  return `sent ${path}`;
}

/** Google Stitch MCP server (HTTP transport) — design generation for operator workers. */
export const STITCH_MCP_URL = "https://stitch.googleapis.com/mcp";

/** Build the project's in-process MCP tools: `send_file` always; `dispatch` only for the company.
 *  When `opts.stitch` is set AND a `opts.stitchKey` is configured, the operator's Stitch HTTP MCP
 *  server is attached too. Stitch is OFF by default so the customer/ingress path never gets it. */
export function neoMcpServers(
  deps: DispatchDeps,
  replyChat: number,
  opts: {
    dispatch: boolean;
    folder: string;
    stitch?: boolean;
    stitchKey?: string;
    /** Operator-only local stdio MCP servers; the customer/ingress path passes neither. */
    gitnexusBin?: string;
    codebaseMemoryBin?: string;
  },
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      "send_file",
      "Send a file you produced in THIS project back to the operator (Telegram/web). `path` must be inside the project folder.",
      {
        path: z.string().describe("path to the file to send, inside the project folder"),
        caption: z.string().optional().describe("optional caption / note"),
      },
      async (args: { path: string; caption?: string }) => {
        const out = await sendProjectFile(deps, replyChat, opts.folder, args.path, args.caption);
        return { content: [{ type: "text" as const, text: out }] };
      },
    ),
  ];
  if (opts.dispatch) {
    tools.push(
      tool(
        "dispatch",
        "Open one of the operator's projects and run a self-contained task in it, then return its result. Use this for any order that belongs to a specific project (e.g. eticket-v3, gold). The target project does NOT see the operator's original message — only your `task` brief — so write `task` as a clear, complete prompt.",
        {
          project: z.string().describe('project folder name under /home, e.g. "eticket-v3"'),
          task: z.string().describe("a clear, self-contained brief/prompt for that project to execute"),
          timeoutMinutes: z
            .number()
            .positive()
            .optional()
            .describe(
              "expected ceiling for this task in minutes — size it to the task (2 for a quick lookup, 60–120 for a real build). Capped by the engine; a hung (silent) worker is still aborted early regardless.",
            ),
        },
        async (args: { project: string; task: string; timeoutMinutes?: number }) => {
          const out = await dispatchToProject(args.project, args.task, deps, replyChat, {
            timeoutMs: args.timeoutMinutes ? Math.round(args.timeoutMinutes * 60_000) : undefined,
          });
          return { content: [{ type: "text" as const, text: out }] };
        },
      ),
    );
  }
  const server = createSdkMcpServer({ name: "neo", version: "1.0.0", tools });
  const servers: Record<string, unknown> = { neo: server };
  // Operator-only: attach the Google Stitch HTTP MCP server when enabled and a key is configured.
  // (SDK McpHttpServerConfig shape: { type: "http", url, headers? }.) Never on the customer path.
  if (opts.stitch && opts.stitchKey) {
    servers.stitch = { type: "http", url: STITCH_MCP_URL, headers: { "X-Goog-Api-Key": opts.stitchKey } };
  }
  // Operator-only local stdio MCP servers: gitnexus (git/code intelligence) + codebase-memory.
  // Attached only when a bin path is configured; the customer/ingress path passes none → never gets them.
  if (opts.gitnexusBin) {
    servers.gitnexus = { type: "stdio", command: opts.gitnexusBin, args: ["mcp"], env: {} };
  }
  if (opts.codebaseMemoryBin) {
    servers["codebase-memory"] = { type: "stdio", command: opts.codebaseMemoryBin, args: [], env: {} };
  }
  return servers;
}
