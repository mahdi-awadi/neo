// The `dispatch` tool — given ONLY to the default project ("the company"). It lets the
// chief-of-staff open one of the operator's projects and run a self-contained brief in it, as a
// tracked, governed Neo sub-project (registry → dashboard, escalations → operator, metered),
// then returns that project's result for the company to summarise. The company writes the brief
// (a tailored prompt), so the sub-project gets a clear order, not the operator's raw message.
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Order } from "../types";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { Meter } from "./budget";
import type { UsageMeter } from "./usage";
import type { TrustStore } from "./trust";
import { runOrder, type RunResult } from "./session-runner";
import { DEFAULT_PROJECT } from "./default-project";

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
}

type RunFn = typeof runOrder;

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
  opts: { run?: RunFn; now?: () => number; root?: string; desks?: string } = {},
): Promise<string> {
  const now = opts.now ?? (() => Date.now());
  const run = opts.run ?? runOrder;
  const folder = resolveProject(project, opts.root, opts.desks);
  if (!folder) return `No project or desk named "${project}" was found — check the name.`;

  const order: Order = { id: crypto.randomUUID(), source: "neo", folder, task, chatId: SUB_CHAT, createdAt: now() };
  deps.ledger.recordOrder(order);
  // Reuse an already-open session for this folder (resume it) instead of duplicating it as
  // "<name>-2"; only register a fresh entry when nothing is open for the folder.
  const existing = deps.registry.findByFolder(folder);
  const session = existing ?? deps.registry.add(order, now());
  if (existing) {
    deps.registry.setStatus(existing.id, "running");
    deps.registry.touch(existing.id, now());
  }
  const name = session.name;
  await deps.reply(replyChat, `→ dispatching to ${name}: ${task}`, name);

  const resume = existing?.sdkSessionId || deps.ledger.lastSessionFor(folder, SUB_CHAT) || undefined;
  let result: RunResult;
  try {
    result = await run(
      order,
      {
        onMessage: (t) => void deps.reply(replyChat, t, name),
        onEscalation: (reason) => deps.askApproval(replyChat, reason),
        onRateLimit: (info) => deps.usage?.noteRateLimit(info),
        autoApprove: () => deps.trust.isTrusted(folder),
        onAutoApprove: (reason) => {
          deps.ledger.recordAutoApproval(order.id, reason);
          void deps.reply(replyChat, `🔓 auto-approved: ${reason}`, name);
        },
      },
      { resume },
    );
  } catch (e) {
    deps.registry.setStatus(session.id, "error");
    return `Dispatch to ${name} failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (result.sessionId) {
    deps.registry.setSdkSessionId(session.id, result.sessionId);
    deps.ledger.recordSession(order.id, result.sessionId);
  }
  deps.meter.note({ costUsd: result.costUsd }, now());
  deps.ledger.recordOutcome(order.id, result.ok ? "done" : "error", result.summary);
  deps.registry.setStatus(session.id, "idle");
  deps.registry.touch(session.id, now());
  return result.summary || (result.ok ? "Done." : "Failed.");
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
        },
        async (args: { project: string; task: string }) => {
          const out = await dispatchToProject(args.project, args.task, deps, replyChat);
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
