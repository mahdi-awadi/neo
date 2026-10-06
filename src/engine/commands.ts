// Frontend-agnostic engine commands, as a small registry so /help auto-lists them and new
// commands are one-liners. handleCommand parses the leading /word, dispatches, and returns a
// CommandResult { text, select? } — or null for /open and anything unregistered, so the
// caller falls through to the order pipeline. `select` is the set of tappable projects for
// /list; BOTH frontends render it as buttons and call selectProject() on a tap (one engine,
// two thin renderers). Operator command shape inspired by operant, trimmed to the SDK model.
import { attentionActions, renderAttention, type AttentionAction } from "./attention-actions";
import { DEFAULT_ATTENTION_CFG } from "./producers/engine";
import type { AttentionRow } from "./ledger";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import type { NeoConfig } from "../config";
import type { UsageMeter, RateLimitInfo } from "./usage";
import type { TrustStore } from "./trust";
import type { Inbox } from "./inbox";
import { renderInboxList, type InboxListEntry } from "./inbox-actions";
import { sessionContext, contextWindows, contextLabel, lastContextReset, resetLabel, type BandCfg, type ContextSignals } from "./context-policy";
import { describeSession, stateOf } from "./session-status";
import type { SessionState } from "./liveness";
import { setWorkerSdk, workerSdkLabel, workerSdkState, type WorkerSdkState } from "./sdk-choice";
import type { TodoQueue } from "./todo-queue";
import type { Updater } from "./updater";
import { renderTrace, type Trace } from "./trace";
import { renderPlans } from "./plans";
import { humanAge } from "./liveness";
import { faults } from "./fault";
import { todoTitle } from "./todo-title";
import { projectDeps, projectSummary, projectSummaries, projectUrl, projectView, recentThreads, renderProject, summaryLine } from "./project-view";

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
  /** The sweet-spot lines (cfg.contextPolicy) — /status names a session's band against them
   *  (ADR-0021). Absent ⇒ the bare ctx% only. */
  contextPolicy?: BandCfg;
  /** Graceful reload (/reload): the daemon injects drain-then-exit; channels without it can't reload. */
  requestReload?: () => void;
  /** Live config object; `/sdk` mutates providers.ownWork for new worker starts. `publicUrl` is the
   *  console base the /trace link points at. */
  cfg?: Pick<NeoConfig, "providers"> & Partial<Pick<NeoConfig, "publicUrl" | "attention" | "github" | "projects">>;
  /** The per-project todo queues (for /todo, ADR-0008). Absent → /todo says it is unavailable. */
  todo?: TodoQueue;
  /** The toolchain updater (for /updates, ADR-0009). Absent → /updates says it is unavailable. */
  updates?: Pick<Updater, "status" | "run" | "rollback" | "running">;
  /** The restart-gated list (spec §8.4, `/gated`): what is built but not running. Absent → unavailable. */
  gated?: () => string;
  /** The cause seam (for /trace, ADR-0015). Absent → /trace says it is unavailable. */
  trace?: Trace;
  /** The Telegram message this command replied to: a bare `/trace` traces that message's thread. */
  replyTo?: { chatId: number; channelMsgId: number };
  /** Neo's own repo (for `/project`). Absent → the daemon's working folder. */
  neoFolder?: string;
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
  /** Updated worker-SDK state (for web UI controls). */
  sdk?: WorkerSdkState;
  /** One-tap attention items (for /attention) — frontends render → todo / snooze / dismiss per item. */
  attention?: Array<Pick<AttentionRow, "id" | "project" | "title" | "severity"> & { actions: AttentionAction[] }>;
  /** A command whose answer needs async reads (`/project` reads git live): the frontend sends THIS
   *  result when it settles, instead of `text`. It never rejects. */
  later?: Promise<CommandResult>;
  /** One project's dashboard (`/project <name>`) — frontends add its buttons: attention (N), threads,
   *  open console. */
  project?: { name: string; attention: number; consoleUrl?: string };
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

interface TrustTarget {
  name: string;
  folder: string;
}

const COMMANDS: Command[] = [
  {
    name: "list",
    aliases: ["ls", "status"],
    usage: "/list",
    summary: "open projects (★ = active · tap a name to switch)",
    run: ({ deps, now, chatId }) => renderList(deps, now, chatId),
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
    usage: "/trust [<project-or-folder>] [on|off]",
    summary: "auto-approve all actions for a project (no Allow/Deny prompts)",
    run: ({ deps, args, chatId }) => trustCommand(args.trim(), chatId, deps),
  },
  {
    name: "todo",
    aliases: ["todos", "queue"],
    usage: "/todo [<project>] · /todo cancel|up <id> · /todo pause|resume <project>",
    summary: "per-project todo queues: list, cancel, move up, pause, resume",
    run: ({ deps, args }) => ({ text: todoCommand(args.trim(), deps.todo) }),
  },
  {
    name: "trace",
    usage: "/trace <ref> (or reply /trace to a Neo message)",
    summary: "show everything a message caused",
    run: ({ deps, args }) => ({ text: traceCommand(args.trim(), deps) }),
  },
  {
    name: "plans",
    usage: "/plans [<project>]",
    summary: "plans and specs the engine sent you: status, steps done, thread",
    run: ({ deps, args }) => ({ text: renderPlans(deps.ledger, deps.trace, args.trim() || undefined) }),
  },
  {
    name: "updates",
    aliases: ["update"],
    usage: "/updates · /updates run · /updates apply|rollback <item>",
    summary: "toolchain updates (SDK, plugins, MCP): status, check now, apply a held one, roll back",
    run: ({ deps, args }) => ({ text: updatesCommand(args.trim(), deps.updates) }),
  },
  {
    name: "attention",
    usage: "/attention [<project>]",
    summary: "what needs you: open items by project, severity first, with → todo / snooze / dismiss",
    run: ({ deps, args, now }) => {
      const c = deps.cfg?.attention ?? DEFAULT_ATTENTION_CFG;
      const r = renderAttention(deps.ledger, { project: args.trim() || undefined, now, maxLines: c.listLines, maxButtons: c.listButtons, consoleUrl: deps.cfg?.publicUrl || undefined });
      return { text: r.text, attention: r.buttons.map((b) => ({ id: b.id, project: b.project, title: b.title, severity: b.severity, actions: attentionActions(b) })) };
    },
  },
  {
    name: "project",
    aliases: ["p"],
    usage: "/project [<name>] · /project <name> threads",
    summary: "a project's dashboard: now, queue, git, GitHub, decisions, plans, attention (no name: every project)",
    run: ({ deps, args, now }) => ({ text: "", later: projectCommand(args.trim(), deps, now) }),
  },
  {
    name: "gated",
    usage: "/gated",
    summary: "what is built but not running yet (commits after boot, branches to merge, updates)",
    run: ({ deps }) => ({ text: deps.gated ? deps.gated() : "/gated is unavailable here" }),
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
    name: "events",
    usage: "/events [<kind>]",
    summary: "recent engine diagnostic events (API retries, dispatch + session lifecycle)",
    run: ({ deps, args }) => ({ text: renderEvents(deps.ledger, args.trim() || undefined) }),
  },
  {
    name: "usage",
    usage: "/usage",
    summary: "subscription token usage (hourly/daily/weekly)",
    run: ({ deps, now }) => ({ text: renderUsage(deps.usage, now) }),
  },
  {
    name: "sdk",
    aliases: ["provider"],
    usage: "/sdk [claude|codex]",
    summary: "show or switch the worker SDK for new own-work sessions",
    run: ({ deps, args }) => sdkCommand(args.trim(), deps.cfg),
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
  const [rawWord, ...rest] = trimmed.slice(1).split(/\s+/);
  // Telegram addresses commands in group chats as `/command@bot_username`. The command is still
  // ours, but without stripping the suffix it silently falls through into the work pipeline.
  const word = rawWord.split("@", 1)[0].toLowerCase();
  const cmd = COMMANDS.find((c) => c.name === word || c.aliases?.includes(word));
  if (!cmd) return null; // /open + unknown -> let the pipeline handle it
  return cmd.run({ chatId, args: rest.join(" "), now: (deps.now ?? (() => Date.now()))(), deps });
}

/** Focus a project one-shot (from a tapped /list button) and return the refreshed list. The one
 * place the tap-switch happens — both Telegram and the web console call this on a tap. One-shot so a
 * tapped project receives the next message, then focus reverts to the company (use /pin to hold). */
export function selectProject(id: string, chatId: number, deps: CommandDeps): CommandResult {
  deps.registry.setFocus(chatId, id, "once");
  return renderList(deps, (deps.now ?? (() => Date.now()))(), chatId);
}

/** Kill a project by id (from a tapped ✕) and return the refreshed list. Shared by both
 * frontends; same effect as /kill <name>, but addressed by the stable session id. */
export function killProject(id: string, chatId: number, deps: CommandDeps): CommandResult {
  const now = (deps.now ?? (() => Date.now()))();
  if (deps.registry.getDefault()?.id === id) {
    return { text: "🔒 the company is always-on and can't be stopped.", select: renderList(deps, now, chatId).select };
  }
  if (deps.registry.get(id)) {
    void deps.registry.getControl(id)?.interrupt();
    deps.registry.setStatus(id, "done");
    deps.registry.remove(id);
  }
  return renderList(deps, now, chatId);
}

const TODO_USAGE = "Usage: /todo · /todo <project> · /todo cancel <id> · /todo up <id> · /todo pause <project> · /todo resume <project>";

/** /todo — read and steer the per-project todo queues. Thin: the queue owns every rule. */
function todoCommand(args: string, todo: TodoQueue | undefined): string {
  if (!todo) return "The todo queue is unavailable on this channel.";
  const words = args.split(/\s+/).filter(Boolean);
  if (words.length > 2) return TODO_USAGE; // never act on half of what was typed
  const [first = "", arg = ""] = words;
  const verb = first.toLowerCase();
  const id = /^#?\d+$/.test(arg) ? Number(arg.replace(/^#/, "")) : NaN; // plain digits only: no 0x2, 2e0
  switch (verb) {
    case "":
      return todo.list();
    case "cancel":
    case "up":
      if (!(id > 0)) return TODO_USAGE;
      return verb === "cancel" ? todo.cancel(id) : todo.up(id);
    case "pause":
    case "resume":
      if (!arg) return TODO_USAGE;
      return verb === "pause" ? todo.pause(arg) : todo.resume(arg);
    default:
      if (arg) return TODO_USAGE;
      return todo.list(first);
  }
}

/** /project — the project dashboard (spec §9): no name → every project's one-line summary; a name →
 *  its dashboard (the P6 sketch) with the attention count and console link the frontends turn into
 *  buttons; `<name> threads` → its newest threads. One bounded message, `attention.listLines` lines. */
async function projectCommand(args: string, deps: CommandDeps, now: number): Promise<CommandResult> {
  try {
    const maxLines = (deps.cfg?.attention ?? DEFAULT_ATTENTION_CFG).listLines;
    const consoleUrl = deps.cfg?.publicUrl || undefined;
    const d = projectDeps({ ledger: deps.ledger, registry: deps.registry, cfg: deps.cfg ?? {}, neoFolder: deps.neoFolder });
    const [name, sub] = args.split(/\s+/).filter(Boolean);
    if (!name) {
      const r = projectSummaries(d, now, Math.max(1, maxLines - 1));
      const more = r.total - r.rows.length;
      return { text: [`projects: ${r.total}`, ...r.rows.map(summaryLine), ...(more > 0 ? [`… +${more} more`] : [])].join("\n") };
    }
    const unknown = { text: `No project "${name}" — /project lists the projects the engine knows.` };
    if (sub === "threads") {
      if (!projectSummary(d, name, now)) return unknown;
      const rows = recentThreads(deps.ledger, name);
      if (!rows.length) return { text: `${name} has no threads yet.` };
      const lines = rows.map((t) => `${t.ref} ${t.state} ${todoTitle(t.title)} (${humanAge(now - t.updatedAt)})`);
      return { text: [`threads of ${name} (newest ${rows.length}):`, ...lines, "/trace <ref> shows one", ...(consoleUrl ? [consoleUrl] : [])].join("\n") };
    }
    const v = await projectView(d, name, now);
    if (!v) return unknown;
    return { text: renderProject(v, now, { maxLines }), project: { name, attention: v.attention.length, ...(consoleUrl ? { consoleUrl: projectUrl(consoleUrl, name) } : {}) } };
  } catch (e) {
    faults.report("command.project", e, { project: args });
    return { text: "The project dashboard failed — the fault is reported." };
  }
}

/** /trace — a message's thread and everything it produced (spec §4.4). Thin: the trace owns the tree. */
function traceCommand(arg: string, deps: CommandDeps): string {
  const { trace, ledger } = deps;
  if (!trace) return "Tracing is unavailable on this channel.";
  let msgId: number | undefined;
  if (arg) {
    msgId = trace.parseRef(arg);
    if (msgId === undefined || !ledger.messageById(msgId)) return `No message ${msgId === undefined ? arg : trace.ref(msgId)} — check the ref`;
  } else if (deps.replyTo) {
    const { chatId, channelMsgId } = deps.replyTo;
    msgId = ledger.messageByChannel(chatId, channelMsgId)?.id ?? ledger.routeCause(chatId, channelMsgId)?.msgId;
    if (msgId === undefined) return "That message is not traced (it is older than tracing). Use /trace <ref>.";
  } else return "Usage: /trace <ref> — or reply /trace to a Neo message.";
  const tree = trace.tree(msgId);
  if (!tree.thread && !tree.pruned) return `Message ${trace.ref(msgId)} has no thread (it is older than tracing).`;
  return renderTrace(tree, trace.ref, { consoleUrl: deps.cfg?.publicUrl });
}

const UPDATES_USAGE = "Usage: /updates · /updates run · /updates apply <item> · /updates rollback <item>";

/** /updates — read and steer the toolchain updater. Thin: the updater owns every rule. A run or a
 *  rollback takes minutes, so it starts in the background; the updater sends its own report. */
function updatesCommand(args: string, updater: CommandDeps["updates"]): string {
  if (!updater) return "The updater is unavailable on this channel.";
  const words = args.split(/\s+/).filter(Boolean);
  const [verb = "", item = ""] = [words[0]?.toLowerCase(), words[1]];
  const background = (p: Promise<unknown>, what: string) =>
    void p.catch((e) => console.error(`[updates] ${what} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
  if (verb === "" && words.length === 0) return updater.status();
  if (verb === "run" && words.length === 1) {
    if (updater.running()) return "An update run is already in progress — its report follows when it ends.";
    background(updater.run({ trigger: "manual" }), "run");
    return "🔄 Update check started — the report follows when it ends.";
  }
  if ((verb === "apply" || verb === "rollback") && item && words.length === 2) {
    if (verb === "rollback") {
      background(updater.rollback(item), `rollback ${item}`);
      return `↩ Rolling back ${item} — the result follows.`;
    }
    if (updater.running()) return "An update run is already in progress — try again when its report arrives.";
    background(updater.run({ trigger: "manual", only: item, force: true }), `apply ${item}`);
    return `⬆ Applying ${item} (held or not) — the result follows.`;
  }
  return UPDATES_USAGE;
}

function inboxCommand(deps: CommandDeps): CommandResult {
  if (!deps.inbox) return { text: "Inbox unavailable." };
  const { text, items } = renderInboxList(deps.inbox);
  return { text, inbox: items };
}

function trustCommand(args: string, chatId: number, deps: CommandDeps): CommandResult {
  const parts = args.split(/\s+/).filter(Boolean);
  const last = parts.at(-1);
  const mode = last === "on" || last === "off" ? last : undefined;
  const targetArg = mode ? parts.slice(0, -1).join(" ") : parts.join(" ");
  const target = resolveTrustTarget(targetArg, chatId, deps.registry);
  if (!target) {
    return { text: targetArg ? `Project or folder not found: ${targetArg}` : "No active project to trust." };
  }
  const folder = target.folder;
  if (mode) {
    deps.trust.setTrust(folder, mode === "on");
    return {
      text:
        mode === "on"
          ? `🔓 trusting ${target.name} (${folder}) — actions auto-approve; writes outside the folder follow governor.outOfFolderWrites, never trust.`
          : `🔒 no longer trusting ${target.name} (${folder}) — actions will prompt again.`,
    };
  }
  const here = deps.trust.isTrusted(folder) ? "🔓 trusted" : "🔒 not trusted";
  const all = deps.trust.list();
  const list = all.length ? `\nTrusted: ${all.join(", ")}` : "";
  return { text: `${target.name} (${folder}): ${here}\nUsage: /trust [<project-or-folder>] [on|off]${list}` };
}

function resolveTrustTarget(targetArg: string, chatId: number, registry: Registry): TrustTarget | undefined {
  if (!targetArg) {
    const active = registry.findByChat(chatId) ?? registry.getDefault();
    return active ? { name: active.name, folder: active.order.folder } : undefined;
  }
  const open = registry.findByName(targetArg);
  if (open) return { name: open.name, folder: open.order.folder };
  const folder = targetArg.startsWith("/") ? targetArg : join("/home", targetArg);
  if (!existsSync(folder)) return undefined;
  return { name: targetArg.startsWith("/") ? basename(folder) : targetArg, folder };
}

function sdkCommand(arg: string, cfg: CommandDeps["cfg"]): CommandResult {
  if (!cfg) return { text: "SDK switching unavailable on this channel." };
  if (!arg) {
    const current = workerSdkState(cfg.providers.ownWork);
    return {
      text: `Worker SDK: ${current.label}\nUsage: /sdk claude · /sdk codex\nNew sessions use this setting; running sessions keep their current SDK.`,
      sdk: current,
    };
  }
  const result = setWorkerSdk(cfg, arg);
  if (!result.ok) {
    return { text: `Unknown SDK: ${arg}\n${result.error}`, sdk: result.sdk };
  }
  const changed = result.changed ? "set to" : "already set to";
  return {
    text: `Worker SDK ${changed} ${workerSdkLabel(result.sdk.provider)}. New sessions use it; running sessions keep their current SDK.`,
    sdk: result.sdk,
  };
}

/** The dot follows the DERIVED state, so the glance and the words agree: a session sitting between
 *  turns is not a busy green dot, and the one row worth acting on is the only red one. */
function stateIcon(state: SessionState): string {
  if (state === "wedged") return "🔴";
  if (state === "awaiting-operator") return "🟠";
  if (state === "working" || state === "quiet") return "🟢";
  if (state === "starting") return "🟡";
  return "⚪️";
}

function renderList(deps: CommandDeps, now: number, chatId: number): CommandResult {
  const { registry, trust, signals, ledger } = deps;
  const windowTokensByModel = contextWindows(ledger, deps.windowTokensByModel);
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
      // ONE vocabulary everywhere: the derived state + both clocks + the queue, exactly as the
      // company's `sessions` tool and dispatch's busy replies render it. The registry `status` is
      // lifecycle bookkeeping and is never shown — "running" for an idle session is the lie this
      // whole surface was built on (ADR 0003).
      const live = describeSession(registry, s, now);
      const state = stateOf(registry, s, now);
      let ctx = "";
      if (s.sdkSessionId) {
        try {
          const sig = (signals ?? sessionContext)(s.order.folder, s.sdkSessionId, { windowTokensByModel });
          if (sig.windowKnown !== false) ctx = ` · ${contextLabel(sig.occupancy, deps.contextPolicy)}`; // no % on a guessed window (ADR-0013)
        } catch {
          // skip on error
        }
      }
      let reset = "";
      try {
        const last = lastContextReset(ledger, s.order.folder);
        if (last) reset = ` · ${resetLabel(last, now)}`;
      } catch {
        // skip on error
      }
      return `${star}${stateIcon(state)} ${lock}${s.name} · ${s.order.folder} · ${live}${ctx}${reset} · "${task}"`;
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

/** Recent engine diagnostic events, newest-first, as compact lines: `HH:MM:SS · kind · where · k=v…`.
 *  The operator's window into the durable event log (API retries, dispatch + session lifecycle).
 *  An optional `kind` filters to one event kind (e.g. `/events api_retry`). */
function renderEvents(ledger: Ledger, kind?: string): string {
  const events = ledger.listEvents({ kind, limit: 20 });
  if (events.length === 0) return kind ? `No events of kind "${kind}".` : "No events yet.";
  return events
    .map((e) => {
      const t = new Date(e.at).toISOString().slice(11, 19); // HH:MM:SS (UTC)
      const where = e.folder ? ` · ${e.folder.split("/").pop()}` : "";
      const data = e.data
        ? " · " +
          Object.entries(e.data)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
      return `${t} · ${e.kind}${where}${data}`;
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
