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
import type { Inbox } from "./inbox";
import { renderInboxList, type InboxListEntry } from "./inbox-actions";
import type { SessionInfo } from "../types";
import { sessionContext, type ContextSignals } from "./context-policy";
import { humanAge } from "./session-status";

export interface CommandDeps {
  registry: Registry;
  ledger: Ledger;
  /** Measured subscription usage (for /usage). Optional so tests/glue can omit it. */
  usage?: UsageMeter;
  /** Injectable clock (session ages). Defaults to Date.now. */
  now?: () => number;
  /** Per-project trust store (for /trust and the 🔓 marker). */
  trust: TrustStore;
  /** Customer inbox (for /inbox). Optional so tests/glue can omit it. */
  inbox?: Inbox;
  /** Context signal function for measuring session occupancy. Optional for tests. Kept as the
   *  same 3-arg shape as sessionContext (opts is optional) so windowTokensByModel below can flow
   *  through a test-injected signals fn too, not just the real one. */
  signals?: (folder: string, sdkSessionId: string, opts?: { windowTokensByModel?: Record<string, number> }) => ContextSignals;
  /** Per-model context-window overrides (cfg.contextPolicy.windowTokensByModel), threaded into the
   *  SAME sessionContext call the gates use — so /status's ctx% agrees with the keep/handoff/clear
   *  verdict instead of drifting when an operator has configured an override (see context-policy.ts
   *  ContextPolicyCfg.windowTokensByModel doc). Optional: undefined ⇒ today's behavior (facts-map
   *  default only). */
  windowTokensByModel?: Record<string, number>;
  /** Graceful reload (/reload): the daemon injects drain-then-exit; channels without it can't reload. */
  requestReload?: () => void;
}

/** A tappable project in a /list result — frontends render these as buttons/rows. */
export interface SelectableProject {
  label: string;
  id: string;
  active: boolean;
  folder: string;
  status: string;
}

/** What a command returns: text to show, plus optional tappable projects or inbox items. */
export interface CommandResult {
  text: string;
  select?: SelectableProject[];
  /** Tappable customer-inbox rows (for /inbox) — frontends render these as buttons. */
  inbox?: InboxListEntry[];
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
    run: ({ deps, now, chatId }) => renderList(deps.registry, deps.trust, now, chatId, deps.signals, deps.windowTokensByModel),
  },
  {
    name: "use",
    aliases: ["switch"],
    usage: "/use <name>",
    summary: "address a project for your NEXT message, then revert to the company",
    run: ({ deps, args, chatId }) => ({ text: focusSession(args.trim(), chatId, deps.registry, "once") }),
  },
  {
    name: "pin",
    usage: "/pin <name>",
    summary: "keep talking to a project across messages (until /unpin)",
    run: ({ deps, args, chatId }) => ({ text: focusSession(args.trim(), chatId, deps.registry, "pinned") }),
  },
  {
    name: "unpin",
    aliases: ["company", "main"],
    usage: "/unpin",
    summary: "return focus to the company / main agent",
    run: ({ deps, chatId }) => {
      deps.registry.clearFocus(chatId);
      return { text: "↩︎ back to the company — your messages go to the main agent." };
    },
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
    name: "inbox",
    usage: "/inbox",
    summary: "review queued customer messages (tap one to view & reply)",
    run: ({ deps }) => inboxCommand(deps),
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
    name: "reload",
    usage: "/reload",
    summary: "gracefully restart the engine (drains running sessions, resumes them after)",
    run: ({ deps }) => {
      if (!deps.requestReload) return { text: "Reload is unavailable on this channel." };
      deps.requestReload(); // drain + exit happens in the background; the supervisor restarts us
      return { text: "♻️ reloading: asking running sessions to wrap up, saving open sessions, then restarting…" };
    },
  },
  {
    name: "help",
    aliases: ["h"],
    usage: "/help",
    summary: "this list",
    run: () => ({ text: renderHelp() }),
  },
];

/** A Telegram bot command in the Bot API's setMyCommands shape. */
export interface TelegramCommand {
  command: string;
  description: string;
}

// Telegram's constraints (Bot API): command names are 1–32 chars of [a-z0-9_]; descriptions ≤ 256.
const TELEGRAM_COMMAND_RE = /^[a-z0-9_]{1,32}$/;
const TELEGRAM_DESC_MAX = 256;

/** Pure: derive Telegram's setMyCommands list from command metadata. Strips a leading slash,
 *  lowercases the name, DROPS any name that violates Telegram's ^[a-z0-9_]{1,32}$ rule, DEDUPES by
 *  command name (first occurrence wins), and truncates each description (the command summary) to
 *  Telegram's 256-char limit. Kept pure and exported so the frontend just registers the result and
 *  the shaping stays unit-tested. */
export function toTelegramCommands(cmds: { name: string; summary: string }[]): TelegramCommand[] {
  const out: TelegramCommand[] = [];
  const seen = new Set<string>();
  for (const c of cmds) {
    const command = c.name.replace(/^\/+/, "").toLowerCase();
    if (!TELEGRAM_COMMAND_RE.test(command)) continue; // skip names Telegram would reject
    if (seen.has(command)) continue; // first occurrence wins (COMMANDS take priority over pipeline)
    seen.add(command);
    out.push({ command, description: c.summary.slice(0, TELEGRAM_DESC_MAX) });
  }
  return out;
}

// Commands handled OUTSIDE the COMMANDS registry, so they have no entry above: /open falls through
// handleCommand (returns null) into the order pipeline, and /loop is intercepted by handleLoop before
// command dispatch. The operator still types them, so they belong in the "/" menu — kept here as
// {name, summary} (summaries mirror the /help usage lines) for telegramCommands() to fold in. Keep in
// sync with the pipeline dispatch in the frontends and the extra /help lines in renderHelp().
const PIPELINE_COMMANDS: { name: string; summary: string }[] = [
  { name: "open", summary: "start or resume a project" },
  { name: "loop", summary: "list, run, or enable/disable automation loops" },
];

/** The engine's operator commands in Telegram's setMyCommands shape: the COMMANDS registry plus the
 *  pipeline commands (/open, /loop), so the "/" menu is the complete set the operator can type. New
 *  COMMANDS entries appear automatically; aliases are not emitted (only each command's canonical
 *  name), and toTelegramCommands dedupes so there's no double entry. */
export function telegramCommands(): TelegramCommand[] {
  return toTelegramCommands([...COMMANDS, ...PIPELINE_COMMANDS]);
}

export function handleCommand(text: string, chatId: number, deps: CommandDeps): CommandResult | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = COMMANDS.find((c) => c.name === word || c.aliases?.includes(word));
  if (!cmd) return null; // /open + unknown -> let the pipeline handle it
  return cmd.run({ chatId, args: rest.join(" "), now: (deps.now ?? (() => Date.now()))(), deps });
}

/** Focus a project one-shot (from a tapped /list button) and return the refreshed list. The one
 * place the tap-switch happens — both Telegram and the web console call this on a tap. One-shot so a
 * tapped project receives the next message, then focus reverts to the company (use /pin to hold). */
export function selectProject(id: string, chatId: number, deps: CommandDeps): CommandResult {
  deps.registry.setFocus(chatId, id, "once");
  return renderList(deps.registry, deps.trust, (deps.now ?? (() => Date.now()))(), chatId, deps.signals, deps.windowTokensByModel);
}

/** Kill a project by id (from a tapped ✕) and return the refreshed list. Shared by both
 * frontends; same effect as /kill <name>, but addressed by the stable session id. */
export function killProject(id: string, chatId: number, deps: CommandDeps): CommandResult {
  const now = (deps.now ?? (() => Date.now()))();
  if (deps.registry.getDefault()?.id === id) {
    return { text: "🔒 the company is always-on and can't be stopped.", select: renderList(deps.registry, deps.trust, now, chatId, deps.signals, deps.windowTokensByModel).select };
  }
  if (deps.registry.get(id)) {
    void deps.registry.getControl(id)?.interrupt();
    deps.registry.setStatus(id, "done");
    deps.registry.remove(id);
  }
  return renderList(deps.registry, deps.trust, now, chatId, deps.signals, deps.windowTokensByModel);
}

function inboxCommand(deps: CommandDeps): CommandResult {
  if (!deps.inbox) return { text: "Inbox unavailable." };
  const { text, items } = renderInboxList(deps.inbox);
  return { text, inbox: items };
}

function trustCommand(arg: string, chatId: number, deps: CommandDeps): CommandResult {
  const target = deps.registry.findByChat(chatId) ?? deps.registry.getDefault();
  if (!target) return { text: "No active project to trust." };
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

function statusIcon(status: SessionInfo["status"]): string {
  return status === "running" ? "🟢" : status === "idle" ? "🟡" : "⚪️";
}

function renderList(
  registry: Registry,
  trust: CommandDeps["trust"],
  now: number,
  chatId: number,
  signals?: CommandDeps["signals"],
  windowTokensByModel?: Record<string, number>,
): CommandResult {
  const sessions = registry.list();
  if (sessions.length === 0) return { text: "No open projects." };
  // The chat's focused project (if any) is the one messages currently address; mark it ▶ (one-shot,
  // reverts after the next message) or 📌 (pinned). With none focused, the company is the target.
  const focus = registry.getFocus(chatId);
  const activeId = focus?.session.id;
  const select: SelectableProject[] = sessions.map((s) => ({
    label: s.name,
    id: s.id,
    active: s.id === activeId,
    folder: s.order.folder,
    status: s.status,
  }));
  const text = sessions
    .map((s) => {
      const star = s.id === activeId ? (focus!.mode === "pinned" ? "📌 " : "▶ ") : "";
      const lock = trust.isTrusted(s.order.folder) ? "🔓 " : "";
      const task = s.order.task.length > 40 ? `${s.order.task.slice(0, 40)}…` : s.order.task;
      const act = s.status === "running" && s.activity ? ` · ${s.activity.label} ${humanAge(now - s.activity.since)}` : "";
      const q = registry.getControl(s.id)?.queued?.() ?? 0;
      const queued = q > 0 ? ` · ${q} queued` : "";
      let ctx = "";
      if (s.sdkSessionId) {
        try {
          const sig = (signals ?? sessionContext)(s.order.folder, s.sdkSessionId, { windowTokensByModel });
          ctx = ` · ctx ${Math.round(sig.occupancy * 100)}%`;
        } catch {
          // skip on error
        }
      }
      return `${star}${statusIcon(s.status)} ${lock}${s.name} · ${s.order.folder} · ${s.status}${act}${queued}${ctx} · ${humanAge(now - s.startedAt)} · "${task}"`;
    })
    .join("\n");
  return { text, select };
}

function focusSession(name: string, chatId: number, registry: Registry, mode: "once" | "pinned"): string {
  if (!name) return `Usage: /${mode === "pinned" ? "pin" : "use"} <name>`;
  const s = registry.findByName(name);
  if (!s) return `Project not found: ${name}`;
  if (s.status !== "running" && s.status !== "idle") return `${name} is closed.`;
  registry.setFocus(chatId, s.id, mode);
  return mode === "pinned"
    ? `📌 pinned ${name} — your messages go to it until /unpin (or /company).`
    : `▶ addressing ${name} for your next message, then back to the company. (/pin ${name} to keep talking to it.)`;
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
    "(plain chat goes to the company; address a project with /use, then it reverts to the company)",
    ...COMMANDS.map((c) => `${c.usage} — ${c.summary}`),
    "/loop [<project> <goal>] — run a verifiable loop (e.g. /loop green)",
  ];
  return lines.join("\n");
}
