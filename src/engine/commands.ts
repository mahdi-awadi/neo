// Frontend-agnostic engine commands, as a small registry so /help auto-lists them and new
// commands are one-liners. handleCommand parses the leading /word, dispatches, and returns the
// reply string — or null for /open and anything unregistered, so the caller falls through to
// the order pipeline. (Operator command shape inspired by operant, trimmed to the SDK model.)
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { SessionInfo } from "../types";

export interface CommandDeps {
  registry: Registry;
  ledger: Ledger;
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

function renderHelp(): string {
  const lines = [
    "Commands:",
    "/open <folder> <task> — start or resume a project",
    "(just chat to follow up the active project)",
    ...COMMANDS.map((c) => `${c.usage} — ${c.summary}`),
  ];
  return lines.join("\n");
}
