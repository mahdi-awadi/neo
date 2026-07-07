// The customer-work ingress: run a Gemini-authored brief on the company (default project) and
// return its result. Used by the gateway over HTTP. Customer-driven, so risky tools auto-deny.
import type { NeoConfig } from "../config";
import type { Order } from "../types";
import { runOrder, type RunResult } from "./session-runner";
import { neoMcpServers, type DispatchDeps } from "./dispatch";
import type { TrustStore } from "./trust";

/** Reserved chat id for company runs driven by a customer brief (never a real operator chat). */
export const CUSTOMER_CHAT = -3;

/** Customer-path trust: a dispatch triggered by a customer brief must NEVER auto-approve risky
 *  tools (firewall: "customer work never auto-approves"), regardless of operator trust. This
 *  inert store makes every dispatched sub-project escalate instead — and ingress denies. */
export function denyAllTrust(): TrustStore {
  return { isTrusted: () => false, setTrust: () => {}, list: () => [] };
}

/** Tools stripped from a TAINTED brief (one that embeds untrusted customer content, e.g. an
 *  inbox draft). The worker can only read project context and produce text. Defense in depth:
 *  the hardened governor default-escalates anything missed here, and this path auto-denies. */
export const TAINTED_DISALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "KillShell",
];

export type IngressDeps = DispatchDeps & {
  cfg: NeoConfig;
  run?: typeof runOrder;
  now?: () => number;
};

export async function runCompanyBrief(
  brief: string,
  deps: IngressDeps,
  opts: { tainted?: boolean } = {},
): Promise<string> {
  const now = deps.now ?? (() => Date.now());
  const run = deps.run ?? runOrder;
  const company = deps.registry.getDefault();
  if (!company) return "The company is not online right now.";

  const order: Order = { id: crypto.randomUUID(), source: "neo", folder: company.order.folder, task: brief, chatId: CUSTOMER_CHAT, createdAt: now() };
  deps.ledger.recordOrder(order);
  deps.registry.setStatus(company.id, "running");
  deps.registry.touch(company.id, now());

  let result: RunResult;
  try {
    result = await run(
      order,
      {
        onMessage: (t) => void deps.reply(CUSTOMER_CHAT, t, company.name),
        onEscalation: async () => "deny", // customer-driven work never auto-performs risky actions
        onRateLimit: (info) => deps.usage?.noteRateLimit(info),
      },
      opts.tainted
        ? { resume: company.sdkSessionId || undefined, effort: "low", disallowedTools: TAINTED_DISALLOWED_TOOLS }
        : { resume: company.sdkSessionId || undefined, effort: "low", mcpServers: neoMcpServers({ ...deps, trust: denyAllTrust() }, CUSTOMER_CHAT, { dispatch: true, folder: company.order.folder }) },
    );
  } catch (e) {
    deps.ledger.recordOutcome(order.id, "error", e instanceof Error ? e.message : String(e));
    deps.registry.setStatus(company.id, "idle");
    return `The company hit an error: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (result.sessionId) {
    deps.registry.setSdkSessionId(company.id, result.sessionId);
    deps.ledger.recordSession(order.id, result.sessionId);
  }
  deps.meter.note({ costUsd: result.costUsd }, now());
  deps.ledger.recordOutcome(order.id, result.ok ? "done" : "error", result.summary ?? "");
  deps.registry.setStatus(company.id, "idle");
  deps.registry.touch(company.id, now());
  return result.summary || (result.ok ? "Done." : "The company couldn't complete that.");
}
