// Frontend-agnostic engine commands. `/status` and `/kill` resolve here (testable);
// frontends just render the returned string. Returns null for anything that isn't a
// command we own, so the caller can fall through to the order pipeline.
// (Operator-facing /status + /kill shape ported from operant, trimmed to the SDK model.)
import type { Meter } from "./budget";
import type { Registry } from "./registry";

export interface CommandDeps {
  registry: Registry;
  meter: Meter;
  /** Injectable clock for the budget readout. Defaults to Date.now. */
  now?: () => number;
}

export function handleCommand(text: string, deps: CommandDeps): string | null {
  const trimmed = text.trim();
  if (trimmed === "/status" || trimmed.startsWith("/status ")) return formatStatus(deps);
  if (trimmed === "/kill" || trimmed.startsWith("/kill ")) {
    return killSession(trimmed.slice("/kill".length).trim(), deps.registry);
  }
  return null;
}

function formatStatus(deps: CommandDeps): string {
  const now = deps.now ?? (() => Date.now());
  const spent = deps.meter.spent(now());
  const remaining = deps.meter.remaining(now());
  const header = `💰 budget: $${spent.toFixed(2)} spent · $${remaining.toFixed(2)} headroom`;

  const sessions = deps.registry.list();
  if (sessions.length === 0) return `${header}\nNo live sessions.`;

  const icon = (status: string) =>
    status === "running" ? "🟢" : status === "idle" ? "🟡" : "⚪️";
  const lines = sessions.map((s) => `${icon(s.status)} ${s.name} (${s.status}) — ${s.order.folder}`);
  return [header, ...lines].join("\n");
}

function killSession(name: string, registry: Registry): string {
  if (!name) return "Usage: /kill <name>";
  const session = registry.findByName(name);
  if (!session) return `Session not found: ${name}`;
  void registry.getControl(session.id)?.interrupt(); // ends the run; supervise records the outcome
  registry.setStatus(session.id, "done");
  registry.remove(session.id); // drop from the live view immediately
  return `Killed session ${name}`;
}
