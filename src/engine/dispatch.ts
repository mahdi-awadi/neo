// The `dispatch` tool — given ONLY to the default project ("the company"). It lets the
// chief-of-staff open one of the operator's projects and run a self-contained brief in it, as a
// tracked, governed Neo sub-project (registry → dashboard, escalations → operator, metered),
// then returns that project's result for the company to summarise. The company writes the brief
// (a tailored prompt), so the sub-project gets a clear order, not the operator's raw message.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Order } from "../types";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { Meter } from "./budget";
import type { UsageMeter } from "./usage";
import { runOrder, type RunResult } from "./session-runner";

/** Reserved chat id for dispatched sub-projects, so they never hijack the operator's free-text
 *  routing (which always falls back to the default project). */
export const SUB_CHAT = -2;

/** Everything dispatch needs — a structural subset of the pipeline's deps. */
export interface DispatchDeps {
  ledger: Ledger;
  registry: Registry;
  meter: Meter;
  usage?: UsageMeter;
  reply: (chatId: number, text: string, project?: string) => void | Promise<void>;
  askApproval: (chatId: number, reason: string) => Promise<"allow" | "deny">;
}

type RunFn = typeof runOrder;

/** Resolve a project reference (a bare name under `root`, or an absolute path) to a folder. */
export function resolveProject(project: string, root = "/home"): string | undefined {
  const candidates = project.startsWith("/") ? [project] : [join(root, project)];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return c;
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
  opts: { run?: RunFn; now?: () => number; root?: string } = {},
): Promise<string> {
  const now = opts.now ?? (() => Date.now());
  const run = opts.run ?? runOrder;
  const folder = resolveProject(project, opts.root);
  if (!folder) return `No project named "${project}" was found under /home — check the name.`;

  const order: Order = { id: crypto.randomUUID(), source: "neo", folder, task, chatId: SUB_CHAT, createdAt: now() };
  deps.ledger.recordOrder(order);
  const session = deps.registry.add(order, now());
  const name = session.name;
  await deps.reply(replyChat, `→ dispatching to ${name}: ${task}`, name);

  let result: RunResult;
  try {
    result = await run(
      order,
      {
        onMessage: (t) => void deps.reply(replyChat, t, name),
        onEscalation: (reason) => deps.askApproval(replyChat, reason),
        onRateLimit: (info) => deps.usage?.noteRateLimit(info),
      },
      { resume: deps.ledger.lastSessionFor(folder, SUB_CHAT) || undefined },
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

/** Build the `mcpServers` record giving the default project its `dispatch` tool. */
export function dispatchMcpServers(deps: DispatchDeps, replyChat: number): Record<string, unknown> {
  const server = createSdkMcpServer({
    name: "neo",
    version: "1.0.0",
    tools: [
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
    ],
  });
  return { neo: server };
}
