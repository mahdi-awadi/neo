// Frontend-agnostic engine commands, as a small registry so /help auto-lists them and new
// commands are one-liners. handleCommand parses the leading /word, dispatches, and returns the
// reply string — or null for /open and anything unregistered, so the caller falls through to
// the order pipeline. (Operator command shape inspired by operant, trimmed to the SDK model.)
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { UsageMeter } from "./usage";
import type { SessionInfo } from "../types";

export interface CommandDeps {
  registry: Registry;
  ledger: Ledger;
  /** Measured subscription usage (for /usage). Optional so tests/glue can omit it. */
  usage?: UsageMeter;
  /** Injectable clock (session ages). Defaults to Date.now. */
  now?: () => number;
}

interface CommandContext {
  chatId: number;
  args: string;
  now: number;
  deps: CommandDeps;
}

interface Command {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  run(ctx: CommandContext): string;
}

const COMMANDS: Command[] = [
  {
    name: "list",
    aliases: ["ls", "status"],
    usage: "/list",
    summary: "open projects (★ = active · name · folder · status · age · task)",
    run: ({ deps, now, chatId }) => renderList(deps.registry, now, chatId),
  },
  {
    name: "use",
    aliases: ["switch"],
    usage: "/use <name>",
    summary: "make a project active (your messages follow up on it)",
    run: ({ deps, args, chatId }) => useSession(args.trim(), chatId, deps.registry),
  },
  {
    name: "kill",
    usage: "/kill <name>",
    summary: "stop a project",
    run: ({ deps, args }) => killSession(args.trim(), deps.registry),
  },
  {
    name: "recent",
    aliases: ["history"],
    usage: "/recent",
    summary: "recent orders + outcomes",
    run: ({ deps }) => renderRecent(deps.ledger),
  },
  {
    name: "usage",
    usage: "/usage",
    summary: "subscription token usage (hourly/daily/weekly)",
    run: ({ deps, now }) => renderUsage(deps.usage, now),
  },
  {
    name: "help",
    aliases: ["h"],
    usage: "/help",
    summary: "this list",
    run: () => renderHelp(),
  },
];

export function handleCommand(text: string, chatId: number, deps: CommandDeps): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = COMMANDS.find((c) => c.name === word || c.aliases?.includes(word));
  if (!cmd) return null; // /open + unknown -> let the pipeline handle it
  return cmd.run({ chatId, args: rest.join(" "), now: (deps.now ?? (() => Date.now()))(), deps });
}

function humanAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function statusIcon(status: SessionInfo["status"]): string {
  return status === "running" ? "🟢" : status === "idle" ? "🟡" : "⚪️";
}

function renderList(registry: Registry, now: number, chatId: number): string {
  const sessions = registry.list();
  if (sessions.length === 0) return "No open projects.";
  const activeId = registry.findByChat(chatId)?.id;
  return sessions
    .map((s) => {
      const star = s.id === activeId ? "★ " : "";
      const task = s.order.task.length > 40 ? `${s.order.task.slice(0, 40)}…` : s.order.task;
      return `${star}${statusIcon(s.status)} ${s.name} · ${s.order.folder} · ${s.status} · ${humanAge(now - s.startedAt)} · "${task}"`;
    })
    .join("\n");
}

function useSession(name: string, chatId: number, registry: Registry): string {
  if (!name) return "Usage: /use <name>";
  const s = registry.findByName(name);
  if (!s) return `Project not found: ${name}`;
  if (s.status !== "running" && s.status !== "idle") return `${name} is closed.`;
  registry.setActive(chatId, s.id);
  return `Now on ${name} — your messages follow up on it.`;
}

function killSession(name: string, registry: Registry): string {
  if (!name) return "Usage: /kill <name>";
  const session = registry.findByName(name);
  if (!session) return `Session not found: ${name}`;
  void registry.getControl(session.id)?.interrupt(); // ends the run; supervise records the outcome
  registry.setStatus(session.id, "done");
  registry.remove(session.id);
  return `Killed session ${name}`;
}

function renderRecent(ledger: Ledger): string {
  const orders = ledger.listRecent(10);
  if (orders.length === 0) return "No orders yet.";
  return orders
    .map((o) => {
      const outcome = ledger.getOutcome(o.id);
      const icon = !outcome ? "⏳" : outcome.status === "done" ? "✓" : "✗";
      const task = o.task.length > 40 ? `${o.task.slice(0, 40)}…` : o.task;
      const status = outcome ? ` (${outcome.status})` : " (pending)";
      return `${icon} ${o.folder} — "${task}"${status}`;
    })
    .join("\n");
}

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function renderUsage(usage: UsageMeter | undefined, now: number): string {
  if (!usage) return "Usage tracking unavailable.";
  const s = usage.snapshot(now);
  const win = (label: string, w: { consumedTokens: number; capTokens: number | null; remaining: number | null }) => {
    const cap = w.capTokens != null ? ` · ${formatTokens(w.remaining ?? 0)} left of ${formatTokens(w.capTokens)}` : "";
    return `${label}: ${formatTokens(w.consumedTokens)} tokens${cap}`;
  };
  const reset = s.weeklyResetAt ? `\nweekly resets ${new Date(s.weeklyResetAt).toUTCString()}` : "";
  return [
    "📊 subscription usage (measured from transcripts)",
    win("hourly", s.perWindow.hourly),
    win("daily ", s.perWindow.daily),
    win("weekly", s.perWindow.weekly),
    `context: ${formatTokens(s.contextOccupancy)} in the last turn${reset}`,
  ].join("\n");
}

function renderHelp(): string {
  const lines = [
    "Commands:",
    "/open <folder> <task> — start or resume a project",
    "(just chat to follow up the active project)",
    ...COMMANDS.map((c) => `${c.usage} — ${c.summary}`),
  ];
  return lines.join("\n");
}
