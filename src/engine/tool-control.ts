// Stop, or send to the background, ONE running tool call of a worker session (ADR-0058). The one seam
// behind the console strip, /stop, /bg and the company's tool_control: it uses the SDK's own controls
// (session-runner's SessionControl.tools), then sweeps the call's leftover host processes by its
// marker and its `docker exec` children inside their containers, steers the worker, and records it.
import { basename } from "node:path";
import type { Ledger } from "./ledger";
import type { Registry } from "./registry";
import { killPids, markedPids, realKill, realProcFs, treeOf, type KillOps, type ProcFs } from "./proc-tree";
import { dockerApiOverSocket, execPidsFor, execTarget, type DockerApi } from "./docker-exec";
import { randomInt } from "node:crypto";

/** The `toolControl` config block (docs/CONFIG.md). */
export interface ToolControlCfg {
  /** SIGTERM → SIGKILL grace for a stopped call's leftover processes. */
  killGraceMs: number;
  /** Telegram posts one Stop/Background notice for a call running longer than this. */
  noticeAfterMs: number;
  /** The Docker Engine socket, for `docker exec` children. */
  dockerSocket: string;
  /** How often the engine checks for notice cards whose call ended, to remove them (in-memory check). */
  cardSweepMs: number;
  /** Tries to remove one card (a 429 or a network error) before it is left in the chat. */
  cardRemoveAttempts: number;
}

export const DEFAULT_TOOL_CONTROL_CFG: ToolControlCfg = { killGraceMs: 5000, noticeAfterMs: 120_000, dockerSocket: "/var/run/docker.sock", cardSweepMs: 5000, cardRemoveAttempts: 5 };

/** Parse the config value; a missing or bad field keeps its default. */
export function readToolControlCfg(raw: unknown): ToolControlCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ms = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : d);
  return {
    killGraceMs: ms(r.killGraceMs, DEFAULT_TOOL_CONTROL_CFG.killGraceMs),
    noticeAfterMs: ms(r.noticeAfterMs, DEFAULT_TOOL_CONTROL_CFG.noticeAfterMs),
    dockerSocket: typeof r.dockerSocket === "string" && r.dockerSocket.startsWith("/") ? r.dockerSocket : DEFAULT_TOOL_CONTROL_CFG.dockerSocket,
    cardSweepMs: ms(r.cardSweepMs, DEFAULT_TOOL_CONTROL_CFG.cardSweepMs),
    cardRemoveAttempts: ms(r.cardRemoveAttempts, DEFAULT_TOOL_CONTROL_CFG.cardRemoveAttempts),
  };
}

export type ToolAction = "stop" | "background";
export type Actor = { kind: "operator"; surface: "web" | "telegram" | "command" } | { kind: "company" };
export type ToolOutcome = "stopped" | "backgrounded" | "not_running" | "refused";

export interface ToolControlResult {
  ok: boolean;
  outcome: ToolOutcome;
  /** One line for the person or agent who asked. */
  text: string;
  toolUseId?: string;
  command?: string;
  log?: string;
  /** What else a stop did or could not do (container processes, survivors) — worth a line of its own. */
  extras?: string[];
}

export interface ToolControlDeps {
  registry: Pick<Registry, "get" | "getControl">;
  ledger: Pick<Ledger, "recordEvent">;
  cfg: ToolControlCfg;
  /** A feed line for the project (the operator channel's reply). */
  reply?: (text: string, project: string, folder: string) => void;
  proc?: ProcFs;
  docker?: DockerApi;
  signal?: KillOps["signal"];
  alive?: KillOps["alive"];
  sleep?: (ms: number) => Promise<void>;
}

const actorLabel = (a: Actor) => (a.kind === "company" ? "company" : `operator:${a.surface}`);
const actorText = (a: Actor) => (a.kind === "company" ? "the chief of staff" : `the operator (${a.surface === "web" ? "console" : a.surface})`);

/** The worker's steer after a stop: what happened, and not to try it again. */
export function stoppedSteer(command: string): string {
  return `The operator stopped your command \`${command}\`. Do not run it again unless told to; go on with the rest of the task, or say what you need.`;
}

export async function controlTool(deps: ToolControlDeps, req: { sessionId: string; toolUseId?: string; action: ToolAction; by: Actor }): Promise<ToolControlResult> {
  const session = deps.registry.get(req.sessionId);
  const control = session ? deps.registry.getControl(session.id) : undefined;
  const tools = control?.tools;
  const name = session?.name ?? "that session";
  if (!session || !tools) return { ok: false, outcome: "not_running", text: `${name} has no running tool call Neo can control.` };
  const running = tools.running();
  const call = req.toolUseId ? running.find((c) => c.toolUseId === req.toolUseId) : [...running].sort((a, b) => b.since - a.since)[0];
  if (!call) return { ok: false, outcome: "not_running", text: `Nothing is running in ${name} right now${req.toolUseId ? " with that id" : ""}.` };
  const folder = session.lane?.projectFolder ?? session.order.folder;
  const project = basename(folder);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const record = (outcome: ToolOutcome, extra: Record<string, unknown> = {}) =>
    deps.ledger.recordEvent("tool_control", { folder, sessionId: session.id, data: { by: actorLabel(req.by), action: req.action, project, session: name, toolUseId: call.toolUseId, summary: call.summary, outcome, ...extra } });

  if (req.action === "background") {
    const r = await tools.background(call.toolUseId);
    if (!r.ok) {
      const outcome: ToolOutcome = r.reason === "not_running" ? "not_running" : "refused";
      record(outcome, { reason: r.reason });
      return { ok: false, outcome, toolUseId: call.toolUseId, command: call.summary, text: `Could not move \`${call.summary}\` to the background: ${r.reason ?? "unknown"}.` };
    }
    let log = tools.logOf?.(call.toolUseId);
    for (let i = 0; i < 20 && !log; i++) {
      await sleep(100); // the SDK's backgrounded result (it names the log) trails the call briefly
      log = tools.logOf?.(call.toolUseId);
    }
    record("backgrounded", { log });
    deps.reply?.(`⏩ moved to the background by ${actorText(req.by)}: ${call.summary}${log ? ` — log ${log}` : ""}`, project, folder);
    return { ok: true, outcome: "backgrounded", toolUseId: call.toolUseId, command: call.summary, ...(log ? { log } : {}), text: `Moved \`${call.summary}\` in ${name} to the background${log ? `; its log is ${log}` : ""}. It keeps running; the worker goes on.` };
  }

  // Stop. Codex: the SDK can only end the whole turn.
  if (tools.provider === "codex") {
    const r = await tools.stop(call.toolUseId);
    record(r.ok ? "stopped" : "not_running", { codexTurn: true });
    if (r.ok) deps.reply?.(`⏹ stopped by ${actorText(req.by)}: the current Codex turn`, project, folder);
    return r.ok
      ? { ok: true, outcome: "stopped", toolUseId: call.toolUseId, text: `Codex has no per-command stop, so the whole turn in ${name} was stopped; the session stays and takes the next message.` }
      : { ok: false, outcome: "not_running", text: `Nothing is running in ${name} right now.` };
  }

  const proc = deps.proc ?? realProcFs;
  const kill: KillOps = { signal: deps.signal ?? realKill.signal, alive: deps.alive ?? realKill.alive, graceMs: deps.cfg.killGraceMs, sleep };
  // Read everything BEFORE the SDK stop reparents the call's processes. Targets are the marked processes
  // still attached to the call's tree; a marked process already detached (ppid 1: a tmux server, a build
  // daemon it started) may serve others and is only reported.
  const marked = markedPids(proc, call.toolUseId);
  const targets = marked.filter((p) => proc.ppid(p) !== 1);
  const detached = marked.length - targets.length;
  kill.stillOurs = (p) => markedPids({ ...proc, list: () => [p] }, call.toolUseId).length > 0 || dockerTargets.has(p);
  // The in-container processes of the call's docker exec clients, looked up while the clients live.
  const docker = deps.docker ?? dockerApiOverSocket(deps.cfg.dockerSocket);
  const dockerTargets = new Set<number>();
  const notes: string[] = [];
  for (const pid of targets) {
    const argv = proc.cmdline(pid);
    if (!argv || !execTarget(argv)) continue;
    const r = await execPidsFor({ argv, cwd: proc.cwd(pid), startedAt: proc.start?.(pid) }, docker, proc.start);
    if (r.note) notes.push(r.note);
    for (const p of r.pids) for (const q of treeOf(proc, p)) dockerTargets.add(q);
  }
  const sdk = await tools.stop(call.toolUseId);
  // stopTask kills the task's shell, not its grandchildren (docs/sdk-notes.md): sweep the call's own.
  const host = await killPids(targets, kill);
  const dockerKilled = dockerTargets.size ? (await killPids([...dockerTargets], kill)).killed : [];
  const stopped = sdk.ok || host.killed.length > 0;
  if (!stopped) {
    if (sdk.reason === "not_running") {
      record("not_running", { reason: sdk.reason });
      return { ok: false, outcome: "not_running", toolUseId: call.toolUseId, command: call.summary, text: `\`${call.summary}\` had already ended in ${name}.` };
    }
    record("refused", { reason: sdk.reason });
    return { ok: false, outcome: "refused", toolUseId: call.toolUseId, command: call.summary, text: `Could not confirm the stop of \`${call.summary}\` in ${name} (${sdk.reason ?? "unknown"}); it may still be running in the background — check /list.` };
  }
  control!.followUp(stoppedSteer(call.summary), "steer");
  record("stopped", { taskId: sdk.taskId, hostKilled: host.killed, survived: host.survived, dockerKilled, dockerNotes: notes });
  deps.reply?.(`⏹ stopped by ${actorText(req.by)}: ${call.summary}`, project, folder);
  const tail = [
    dockerKilled.length ? `${dockerKilled.length} process${dockerKilled.length === 1 ? "" : "es"} inside containers stopped too` : "",
    detached ? `${detached} detached process${detached === 1 ? "" : "es"} it started left running (it may serve others)` : "",
    host.survived.length ? `${host.survived.length} process${host.survived.length === 1 ? "" : "es"} would not stop` : "",
    ...notes,
  ].filter(Boolean);
  return { ok: true, outcome: "stopped", toolUseId: call.toolUseId, command: call.summary, ...(tail.length ? { extras: tail } : {}), text: `Stopped \`${call.summary}\` in ${name}; the session goes on.${tail.length ? ` (${tail.join("; ")})` : ""}` };
}

/** "14m" / "2h" — how long a call has run. */
function ageOf(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m >= 120 ? `${Math.floor(m / 60)}h` : `${m}m`;
}

/** One running call as a list line: `Bash 14m: git push origin dev`. */
export function callLine(c: { tool: string; summary: string; since: number }, now: number): string {
  return `${c.tool} ${ageOf(now - c.since)}: ${c.summary}`;
}

/** Act on a project's MAIN session's running call, by project (session) name. With several running
 *  calls and no pick, it lists them numbered instead (the commands and the company's tool). */
export async function controlByProject(
  deps: ToolControlDeps & { registry: Pick<Registry, "get" | "getControl" | "findByName" | "list">; now?: () => number },
  req: { project: string; pick?: number; toolUseId?: string; action: ToolAction; by: Actor },
): Promise<ToolControlResult> {
  const now = (deps.now ?? Date.now)();
  const s =
    deps.registry.findByName(req.project) ??
    deps.registry.list().find((x) => !x.lane && (x.status === "running" || x.status === "idle") && basename(x.order.folder) === req.project);
  if (!s) return { ok: false, outcome: "not_running", text: `No open session named ${req.project}.` };
  const calls = [...(deps.registry.getControl(s.id)?.tools?.running() ?? [])].sort((a, b) => a.since - b.since);
  let toolUseId = req.toolUseId;
  if (!toolUseId && req.pick !== undefined) {
    toolUseId = calls[req.pick - 1]?.toolUseId;
    if (!toolUseId) return { ok: false, outcome: "not_running", text: `${s.name} has no running command ${req.pick}.` };
  }
  if (!toolUseId && calls.length > 1) {
    const verb = req.action === "stop" ? "stop" : "bg";
    return {
      ok: false,
      outcome: "not_running",
      text: `${s.name} runs ${calls.length} tool calls — say which:\n${calls.map((c, i) => `${i + 1}. ${callLine(c, now)}`).join("\n")}\n(/${verb} ${req.project} 2 acts on the second.)`,
    };
  }
  return controlTool(deps, { sessionId: s.id, ...(toolUseId ? { toolUseId } : {}), action: req.action, by: req.by });
}

/** A call that has run long enough for a Telegram notice (ADR-0058). `key` is short: button data is ≤ 64 bytes. */
export interface ToolNotice {
  key: number;
  sessionId: string;
  name: string;
  project: string;
  provider: "claude" | "codex";
  call: { toolUseId: string; tool: string; summary: string; since: number };
}

/** Where a notice was posted: the Telegram chat and message of its card. */
export interface ToolCard {
  chatId: number;
  messageId: number;
}
/** A card waiting to be removed: how often removal was tried, and not before when (a 429's retry_after). */
export type PendingCard = ToolCard & { attempts: number; notBefore: number };

/** The notice store: which calls were announced (once each), the short keys their buttons carry, and
 *  the card each notice was posted as. A card whose call ends (by itself, by Stop or by Background, from
 *  any surface) is handed over once for removal (ADR-0058 amendment). */
export function createToolNotices() {
  // A random start each boot: a stale notice's button from before a restart never names a new call.
  let next = 1 + randomInt(1_000_000_000);
  const byKey = new Map<number, { sessionId: string; toolUseId: string }>();
  const cards = new Map<number, ToolCard>(); // key -> its posted card
  const announced = new Set<string>(); // `${sessionId} ${toolUseId}`
  let ended: PendingCard[] = [];
  const pending = (c: ToolCard): PendingCard => ({ chatId: c.chatId, messageId: c.messageId, attempts: 0, notBefore: 0 });

  /** The live calls per session; ended calls lose their keys, and their cards go to `ended`. */
  const sweep = (registry: Pick<Registry, "list" | "getControl">): LiveCalls[] => {
    const live: LiveCalls[] = [];
    const ids = new Set<string>();
    for (const s of registry.list()) {
      const tools = registry.getControl(s.id)?.tools;
      if (!tools) continue;
      const calls = tools.running();
      live.push({ s, provider: tools.provider, calls });
      for (const c of calls) ids.add(`${s.id} ${c.toolUseId}`);
    }
    for (const [k, v] of byKey) {
      if (ids.has(`${v.sessionId} ${v.toolUseId}`)) continue;
      byKey.delete(k);
      const card = cards.get(k);
      if (card) ended.push(pending(card));
      cards.delete(k);
    }
    for (const id of announced) if (!ids.has(id)) announced.delete(id);
    return live;
  };

  return {
    /** Calls past `afterMs` not announced yet (each gets a key). Ended calls lose their keys. */
    due(registry: Pick<Registry, "list" | "getControl">, now: number, afterMs: number): ToolNotice[] {
      const out: ToolNotice[] = [];
      for (const { s, provider, calls } of sweep(registry)) {
        for (const c of calls) {
          const id = `${s.id} ${c.toolUseId}`;
          if (announced.has(id) || now - c.since < afterMs) continue;
          announced.add(id);
          const key = next++;
          byKey.set(key, { sessionId: s.id, toolUseId: c.toolUseId });
          out.push({ key, sessionId: s.id, name: s.name, project: basename(s.lane?.projectFolder ?? s.order.folder), provider, call: c });
        }
      }
      return out;
    },
    /** Find the calls that ended since the last look, and queue their cards for removal. */
    sweep(registry: Pick<Registry, "list" | "getControl">): void {
      sweep(registry);
    },
    resolve: (key: number) => byKey.get(key),
    /** The card a notice was posted as. A call that ended while it was being sent: queued at once. */
    attach(key: number, card: ToolCard): void {
      if (byKey.has(key)) cards.set(key, card);
      else ended.push(pending(card));
    },
    /** Take a notice out now (its Stop or Background was tapped); its card, if any, for the caller to remove. */
    retire(key: number): ToolCard | undefined {
      byKey.delete(key);
      const card = cards.get(key);
      cards.delete(key);
      return card;
    },
    /** The cards to remove now (their call ended, and any retry_after has passed); each is handed over once. */
    takeEnded(now: number): PendingCard[] {
      const due = ended.filter((c) => c.notBefore <= now);
      ended = ended.filter((c) => c.notBefore > now);
      return due;
    },
    /** Every card still in a chat — attached and waiting — for the shutdown sweep; the store forgets them. */
    takeAll(): ToolCard[] {
      const all: ToolCard[] = [...cards.values(), ...ended].map((c) => ({ chatId: c.chatId, messageId: c.messageId }));
      cards.clear();
      byKey.clear();
      ended = [];
      return all;
    },
    /** A removal to try again, not before `notBefore`. False once it has failed `maxAttempts` times (dropped). */
    requeue(card: ToolCard | PendingCard, notBefore: number, maxAttempts: number): boolean {
      const attempts = ("attempts" in card ? card.attempts : 0) + 1;
      if (attempts >= maxAttempts) return false;
      ended.push({ chatId: card.chatId, messageId: card.messageId, attempts, notBefore });
      return true;
    },
  };
}
type LiveCalls = { s: ReturnType<Registry["list"]>[number]; provider: ToolNotice["provider"]; calls: ToolNotice["call"][] };
export type ToolNotices = ReturnType<typeof createToolNotices>;

/** `tc:s:<key>` (Stop, asks to confirm) · `tc:S:<key>` (confirmed Stop) · `tc:b:<key>` (Background). */
export function parseToolCallback(data: string): { step: "stop" | "confirmStop" | "background"; key: number } | undefined {
  const m = /^tc:([sSb]):(\d{1,9})$/.exec(data);
  if (!m) return undefined;
  return { step: m[1] === "s" ? "stop" : m[1] === "S" ? "confirmStop" : "background", key: Number(m[2]) };
}
