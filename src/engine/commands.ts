// Frontend-agnostic engine commands, as a small registry so /help auto-lists them and new
// commands are one-liners. handleCommand parses the leading /word, dispatches, and returns a
// CommandResult { text, select? } — or null for /open and anything unregistered, so the
// caller falls through to the order pipeline. `select` is the set of tappable projects for
// /list; BOTH frontends render it as buttons and call selectProject() on a tap (one engine,
// two thin renderers). Operator command shape inspired by operant, trimmed to the SDK model.
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { UsageMeter, RateLimitInfo } from "./usage";
import type { TrustStore } from "./trust";
import type { SessionInfo } from "../types";

export interface CommandDeps {
  registry: Registry;
  ledger: Ledger;
  /** Measured subscription usage (for /usage). Optional so tests/glue can omit it. */
  usage?: UsageMeter;
  /** Injectable clock (session ages). Defaults to Date.now. */
  now?: () => number;
  /** Per-project trust store (for /trust and the 🔓 marker). */
  trust: TrustStore;
}

/** A tappable project in a /list result — frontends render these as buttons/rows. */
export interface SelectableProject {
  label: string;
  id: string;
  active: boolean;
  folder: string;
  status: string;
}

/** What a command returns: text to show, plus optional tappable projects. */
export interface CommandResult {
  text: string;
  select?: SelectableProject[];
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
  run(ctx: CommandContext): CommandResult;
}

const COMMANDS: Command[] = [
  {
    name: "list",
    aliases: ["ls", "status"],
    usage: "/list",
    summary: "open projects (★ = active · tap a name to switch)",
    run: ({ deps, now, chatId }) => renderList(deps.registry, deps.trust, now, chatId),
  },
  {
    name: "use",
    aliases: ["switch"],
    usage: "/use <name>",
    summary: "make a project active (your messages follow up on it)",
    run: ({ deps, args, chatId }) => ({ text: useSession(args.trim(), chatId, deps.registry) }),
  },
  {
    name: "kill",
    usage: "/kill <name>",
    summary: "stop a project",
    run: ({ deps, args }) => ({ text: killSession(args.trim(), deps.registry) }),
  },
  {
    name: "trust",
    usage: "/trust [on|off]",
    summary: "auto-approve all actions for the active project (no Allow/Deny prompts)",
    run: ({ deps, args, chatId }) => trustCommand(args.trim(), chatId, deps),
  },
  {
    name: "recent",
    aliases: ["history"],
    usage: "/recent",
    summary: "recent orders + outcomes",
    run: ({ deps }) => ({ text: renderRecent(deps.ledger) }),
  },
  {
    name: "usage",
    usage: "/usage",
    summary: "subscription token usage (hourly/daily/weekly)",
    run: ({ deps, now }) => ({ text: renderUsage(deps.usage, now) }),
  },
  {
    name: "help",
    aliases: ["h"],
    usage: "/help",
    summary: "this list",
    run: () => ({ text: renderHelp() }),
  },
];

export function handleCommand(text: string, chatId: number, deps: CommandDeps): CommandResult | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = COMMANDS.find((c) => c.name === word || c.aliases?.includes(word));
  if (!cmd) return null; // /open + unknown -> let the pipeline handle it
  return cmd.run({ chatId, args: rest.join(" "), now: (deps.now ?? (() => Date.now()))(), deps });
}

/** Make a project active (from a tapped /list button) and return the refreshed list. The one
 * place the switch happens — both Telegram and the web console call this on a tap. */
export function selectProject(id: string, chatId: number, deps: CommandDeps): CommandResult {
  deps.registry.setActive(chatId, id);
  return renderList(deps.registry, deps.trust, (deps.now ?? (() => Date.now()))(), chatId);
}

/** Kill a project by id (from a tapped ✕) and return the refreshed list. Shared by both
 * frontends; same effect as /kill <name>, but addressed by the stable session id. */
export function killProject(id: string, chatId: number, deps: CommandDeps): CommandResult {
  const now = (deps.now ?? (() => Date.now()))();
  if (deps.registry.getDefault()?.id === id) {
    return { text: "🔒 the company is always-on and can't be stopped.", select: renderList(deps.registry, deps.trust, now, chatId).select };
  }
  if (deps.registry.get(id)) {
    void deps.registry.getControl(id)?.interrupt();
    deps.registry.setStatus(id, "done");
    deps.registry.remove(id);
  }
  return renderList(deps.registry, deps.trust, now, chatId);
}

function trustCommand(arg: string, chatId: number, deps: CommandDeps): CommandResult {
  const explicit = deps.registry.findByChat(chatId);
  const target = explicit ?? deps.registry.getDefault();
  if (!target) return { text: "No active project to trust." };
  const isCompanyFallback = !explicit && target.id === deps.registry.getDefault()?.id;
  if (arg === "on" && isCompanyFallback) {
    return { text: "Use /use <project> first — the always-on company project cannot be blanket-trusted." };
  }
  const folder = target.order.folder;
  if (arg === "on" || arg === "off") {
    deps.trust.setTrust(folder, arg === "on");
    return {
      text:
        arg === "on"
          ? `🔓 trusting ${target.name} (${folder}) — actions auto-approve, no prompts.`
          : `🔒 no longer trusting ${target.name} (${folder}) — actions will prompt again.`,
    };
  }
  const here = deps.trust.isTrusted(folder) ? "🔓 trusted" : "🔒 not trusted";
  const all = deps.trust.list();
  const list = all.length ? `\nTrusted: ${all.join(", ")}` : "";
  return { text: `${target.name} (${folder}): ${here}\nUsage: /trust on · /trust off${list}` };
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

function renderList(registry: Registry, trust: CommandDeps["trust"], now: number, chatId: number): CommandResult {
  const sessions = registry.list();
  if (sessions.length === 0) return { text: "No open projects." };
  const activeId = registry.findByChat(chatId)?.id;
  const select: SelectableProject[] = sessions.map((s) => ({
    label: s.name,
    id: s.id,
    active: s.id === activeId,
    folder: s.order.folder,
    status: s.status,
  }));
  const text = sessions
    .map((s) => {
      const star = s.id === activeId ? "★ " : "";
      const lock = trust.isTrusted(s.order.folder) ? "🔓 " : "";
      const task = s.order.task.length > 40 ? `${s.order.task.slice(0, 40)}…` : s.order.task;
      return `${star}${statusIcon(s.status)} ${lock}${s.name} · ${s.order.folder} · ${s.status} · ${humanAge(now - s.startedAt)} · "${task}"`;
    })
    .join("\n");
  return { text, select };
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
  if (registry.getDefault()?.id === session.id) return "🔒 the company is always-on and can't be stopped.";
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

function rateLimitName(t?: string): string {
  switch (t) {
    case "five_hour":
      return "5-hour";
    case "seven_day":
      return "7-day";
    case "seven_day_opus":
      return "7-day (Opus)";
    case "seven_day_sonnet":
      return "7-day (Sonnet)";
    case "overage":
      return "overage";
    default:
      return t ?? "limit";
  }
}

// Claude only sends a precise `utilization` as you approach the limit; otherwise it sends
// just status + reset. Render the % when present, else the status — never a fabricated number.
function renderRateLine(r: RateLimitInfo): string {
  const name = rateLimitName(r.rateLimitType);
  const reset = r.resetsAt ? ` · resets ${new Date(r.resetsAt * 1000).toUTCString()}` : "";
  if (typeof r.utilization === "number") {
    const used = Math.round(r.utilization <= 1 ? r.utilization * 100 : r.utilization);
    const icon = r.status === "rejected" ? "⛔" : used >= 80 ? "⚠️" : "🟢";
    return `${icon} ${name}: ${used}% used · ${100 - used}% left${reset}`;
  }
  const icon = r.status === "rejected" ? "⛔" : r.status === "allowed_warning" ? "⚠️" : "✅";
  const label = r.status === "rejected" ? "limit reached" : r.status === "allowed_warning" ? "near limit" : "within limit";
  return `${icon} ${name}: ${label}${reset}`;
}

function renderUsage(usage: UsageMeter | undefined, now: number): string {
  if (!usage) return "Usage tracking unavailable.";
  const s = usage.snapshot(now);
  const lines = ["📊 subscription usage"];
  if (s.rateLimits.length === 0) lines.push("(limit status shows after the first run since restart)");
  for (const r of s.rateLimits) lines.push(renderRateLine(r));
  lines.push(
    `measured: hourly ${formatTokens(s.perWindow.hourly.consumedTokens)} · daily ${formatTokens(s.perWindow.daily.consumedTokens)} · weekly ${formatTokens(s.perWindow.weekly.consumedTokens)} tokens · context ${formatTokens(s.contextOccupancy)}`,
  );
  if (s.weeklyResetAt) lines.push(`weekly resets ${new Date(s.weeklyResetAt).toUTCString()}`);
  return lines.join("\n");
}

function renderHelp(): string {
  const lines = [
    "Commands:",
    "/open <folder> <task> — start or resume a project",
    "(just chat to follow up the active project)",
    ...COMMANDS.map((c) => `${c.usage} — ${c.summary}`),
    "/loop [<project> <goal>] — run a verifiable loop (e.g. /loop gold gofmt)",
  ];
  return lines.join("\n");
}
