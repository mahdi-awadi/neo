// The channel you talk to projects through. Thin grammy glue over the engine pipeline:
// it translates Telegram updates into handleOrder() calls and renders escalations as
// Allow/Deny inline buttons. All the logic lives in engine/pipeline.ts (tested); this
// file is I/O wiring, verified at the daemon e2e step.
import { Api, Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import type { ApiClientOptions } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { saveInbound } from "../engine/files";
import type { NeoConfig } from "../config";
import type { Ledger, DecisionRow } from "../engine/ledger";
import type { Registry } from "../engine/registry";
import type { Meter } from "../engine/budget";
import type { AdminStore } from "../engine/admin";
import type { UsageMeter } from "../engine/usage";
import type { TrustStore } from "../engine/trust";
import type { Inbox } from "../engine/inbox";
import type { TodoQueue } from "../engine/todo-queue";
import { createRegistry } from "../engine/registry";
import { createMeter } from "../engine/budget";
import { openTrustStore } from "../engine/trust";
import { handleMessage, dispatchDepsFrom } from "../engine/pipeline";
import { sharedCodebaseMemoryIndexer } from "../engine/codebase-memory";
import { createMessageRoutes } from "../engine/message-routes";
import { routeReply, answerDecision } from "../engine/reply-routing";
import { handleCommand, selectProject, killProject, telegramCommands, type CommandDeps, type SelectableProject, type TelegramCommand } from "../engine/commands";
import { handleLoop, listLoops, matchLoop, launchLoop } from "../engine/loops";
import { renderInboxItem, draftInboxReply, sendInboxReply, type InboxListEntry, type InboxSendOutcome } from "../engine/inbox-actions";
import type { IngressDeps } from "../engine/ingress";
import { deliverChunked, projectHashtag } from "../engine/format";
import { createFloodGate, isToolStepLine, type FloodGate } from "./telegram-flood";
import type { OperatorBus, OperatorSink } from "../engine/operator-bus";
import { surfaceFor, routeChat, priorityBadge, accentPrefix, type Priority } from "../engine/priority";
import { openEscalationDecision, resolveEscalationDecision } from "../engine/escalation";
import type { ApiCooldown } from "../engine/api-retry";
import { faults } from "../engine/fault";
import {
  keyboardRows,
  parseDecisionCallback,
  emptySelection,
  applyTap,
  isComplete,
  needsSubmit,
  answerText,
  type StructuredAsk,
  type Selection,
  type DecisionTap,
} from "../engine/structured-question";

/** Prefix for every project-attributed outbound line: a clickable Telegram hashtag
 *  (#waselni, #eticket_v3, ...) so tapping it filters the chat to that project. Kept as plain
 *  text — never wrapped in <code>/<pre> — so Telegram auto-links it under parse_mode HTML too. */
export function projectTagPrefix(project?: string): string {
  return project ? `${projectHashtag(project)} ` : "";
}

/** The full first-chunk prefix for an outbound line: the priority's single colored accent (🟢/🔴/…
 *  from the central style map, empty for the silent `progress` firehose) then the clickable #project
 *  tag. This is the ONE place styling + attribution compose, so every Telegram outbound line reads
 *  consistently (Feature 2). Both parts stay plain text (outside any code entity) so Telegram renders
 *  the emoji and auto-links the hashtag under parse_mode HTML. */
export function outboundTag(project?: string, priority?: Priority): string {
  return `${accentPrefix(priority)}${projectTagPrefix(project)}`;
}

/** Build the Telegram operator sink (pure — no Bot instance, so it's unit-testable). Lines mirrored
 *  from the OTHER surface (the web console) render in the admin's DM: a `reply` as project-tagged
 *  worker output, an `echo` as the operator's own web-typed message, a `notice` as display-only
 *  chrome (e.g. an approval pending on the web). Output-only — it never re-enters the pipeline, so a
 *  mirrored line can't become an order (see operator-bus.ts). No admin claimed yet → no-op. */
export function makeTelegramSink(deps: {
  adminId: () => number | undefined;
  /** The unmuted "Decisions" chat (cfg.decisionsChatId). A DECISION/ALERT reply routes here; a
   *  PROGRESS/DONE reply stays in the admin DM (the muted firehose). Unset/undefined → decisions
   *  degrade safely to the DM. Optional so tests/older call sites that don't split surfaces work. */
  decisionsChatId?: () => number | undefined;
  reply: (chatId: number, text: string, project?: string, priority?: Priority) => void;
  plain: (chatId: number, text: string) => void;
}): OperatorSink {
  return {
    id: "telegram",
    deliver: (line) => {
      const dm = deps.adminId();
      if (dm === undefined) return; // nowhere to deliver — no operator has claimed admin yet
      if (line.kind === "reply") {
        // Two-surface routing: DECISION/ALERT → the notified Decisions chat (fall back to the DM
        // when it isn't configured); PROGRESS/DONE → the muted DM firehose. Deterministic (surfaceFor).
        const target = surfaceFor(line.priority ?? "progress") === "decisions" ? (deps.decisionsChatId?.() ?? dm) : dm;
        deps.reply(target, line.text, line.project, line.priority);
      } else if (line.kind === "echo") deps.plain(dm, `🌐 you (web): ${line.text}`);
      else deps.plain(dm, line.text);
    },
  };
}

async function downloadTelegramFile(token: string, filePath: string): Promise<Uint8Array> {
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  return new Uint8Array(await r.arrayBuffer());
}

// One flood gate per process: the bot (startTelegram) and the loop scheduler's raw sends
// (sendOperatorLine) share a token, so they must share Telegram's rate-limit state too.
// startTelegram replaces it with one built from config that can post the "not delivered" notice.
let floodGate: FloodGate = createFloodGate({ maxWaitMs: 30_000 });

/** Put a Bot API client behind the shared flood gate (read at call time, so a client made before
 *  startTelegram swaps the gate still shares it). The bot and the daemon's own operator lines (loop
 *  output, alerts) both go through it, so no send bypasses Telegram's rate-limit state. */
export function installFloodGate(api: Api): Api {
  api.config.use((prev, method, payload, signal) =>
    floodGate.run(method, (payload as { chat_id?: number | string } | undefined)?.chat_id, () => prev(method, payload, signal)),
  );
  return api;
}

/** A Bot API client for engine-side sends (alerts, scheduled-loop lines), behind the flood gate. */
export function createOperatorApi(token: string): Api {
  return installFloodGate(new Api(token));
}

/** Send worker output as formatted HTML (bold/code/bullets), falling back to plain text if
 *  Telegram rejects the markup. `project` tags which project the line came from. Returns the sent
 *  message id (so the caller can route a later reply back to the right session), or undefined if
 *  the send failed. Worker output is sent as plain messages — NOT quote-replies to the operator's
 *  order — so a streamed run doesn't show every line threaded under one old message.
 *  This and sendOperatorLine are the only Telegram egress for worker output, so the tool-step
 *  filter lives here once: a "🔧 Tool: …" / "↳ …" line is dropped unless `toolSteps` (config
 *  `telegramToolSteps`) opts in. The web console and the ledger still get every line. */
export async function sendFormatted(
  bot: { api: Pick<Bot["api"], "sendMessage"> },
  chatId: number,
  text: string,
  opts: { project?: string; priority?: Priority; toolSteps?: boolean } = {},
): Promise<number | undefined> {
  const { project, priority } = opts;
  if (!opts.toolSteps && isToolStepLine(text)) return undefined;
  // Feature 2: the first chunk leads with the priority's single colored accent, then the #project
  // tag. progress (the default) is silent, so streamed worker output reads exactly as it did before.
  const tag = outboundTag(project, priority);
  // Chunk long output: Telegram rejects any single message over 4096 chars, so a long/table-heavy
  // report must be split into multiple rich messages (never dropped). deliverChunked builds each
  // body (rich HTML, or plain hard-split fallback); we just send whatever body it hands us.
  return deliverChunked(
    async (body, html) => {
      try {
        const m = await bot.api.sendMessage(chatId, body, html ? { parse_mode: "HTML" } : {});
        return { ok: true, id: m.message_id };
      } catch {
        return { ok: false };
      }
    },
    text,
    tag,
  );
}

/** Post a single line to the operator's chat over the raw Bot API (no grammy Bot instance needed),
 *  project-tagged + HTML-formatted with a plain-text fallback — the same #project style as streamed
 *  worker/dispatch output. Used by the daemon's loop scheduler so scheduled-loop worker output
 *  reaches the operator's Telegram channel, not just daemon stdout. A dropped line never throws.
 *  Tool-step lines are dropped unless `toolSteps` opts in (see sendFormatted); the loop mirror
 *  still sends them to the web console. */
export async function sendOperatorLine(
  api: Pick<Api, "sendMessage">,
  chatId: number,
  text: string,
  project?: string,
  opts: { toolSteps?: boolean } = {},
): Promise<void> {
  if (!opts.toolSteps && isToolStepLine(text)) return;
  const tag = projectTagPrefix(project);
  // Chunk long output so a >4096-char line/report is split into multiple messages instead of being
  // rejected+dropped by Telegram. deliverChunked handles rich-HTML-then-plain fallback per chunk.
  await deliverChunked(
    async (body, html) => {
      try {
        await api.sendMessage(chatId, body, html ? { parse_mode: "HTML" } : {});
        return { ok: true };
      } catch {
        return { ok: false }; // a dropped loop line must never crash the daemon (the flood gate logged it)
      }
    },
    text,
    tag,
  );
}

/** Build the bot with every handler wired, without polling (tests drive it through `handleUpdate`).
 *  `startTelegram` is this plus the command menu and long polling. */
export function createTelegramBot(
  cfg: NeoConfig,
  ledger: Ledger,
  admin: AdminStore,
  registry: Registry = createRegistry(),
  meter: Meter = createMeter({
    windowBudgetUsd: cfg.budgetWindowUsd,
    reservePct: cfg.subscriptionInteractiveReservePct,
    windowMs: cfg.budgetWindowMs,
  }),
  trust: TrustStore,
  usage?: UsageMeter,
  inbox?: Inbox,
  gatewaySendUrl?: string,
  /** Engine-control hooks (daemon-injected): the reload drain gate, the /reload trigger, and the
   *  shared API-throttle gate that holds background work while Anthropic is rate-limiting us. */
  reload?: { lifecycle?: { draining(): boolean }; requestReload?: () => void; cooldown?: ApiCooldown; todo?: TodoQueue; updates?: CommandDeps["updates"] },
  /** Operator-channel broadcast bus — mirror this surface to the web console and vice-versa. */
  bus?: OperatorBus,
  opts: { botInfo?: UserFromGetMe; client?: ApiClientOptions } = {},
): Bot {
  const bot = new Bot(cfg.telegramToken, { botInfo: opts.botInfo, client: opts.client });
  // Every Bot API call goes through the flood gate: failed sends are logged (never silently
  // swallowed again), a long 429 holds that chat instead of extending the ban, and when it lifts
  // the operator is told how many messages they missed.
  floodGate = createFloodGate({
    maxWaitMs: cfg.telegramFloodMaxWaitMs,
    onRecovered: (chatId, dropped) =>
      faults.contain("telegram.send", () =>
        bot.api.sendMessage(
          chatId,
          `⚠️ Telegram rate-limited Neo in this chat — ${dropped} message(s) were not delivered.` +
            (cfg.publicUrl ? ` The full log is in the web console: ${cfg.publicUrl}` : " The full log is in the web console."),
        ),
      ),
  });
  installFloodGate(bot.api);
  // A failed update is one unit of work (ADR-0010): the error boundary reports it and polling goes
  // on. bot.catch is the backstop for anything outside it — grammy's default handler stops polling.
  const reportUpdate = (err: { error: unknown; ctx: Context }) =>
    faults.report("telegram.update", err.error, { updateId: err.ctx.update.update_id, chatId: err.ctx.chat?.id });
  bot.catch(reportUpdate);
  const on = bot.errorBoundary(reportUpdate);
  // A send nobody awaits: its failure (already logged by the flood gate) is reported, never an
  // unhandled rejection.
  const say = (chatId: number, text: string, extra?: Parameters<Bot["api"]["sendMessage"]>[2]): void =>
    faults.contain("telegram.send", () => bot.api.sendMessage(chatId, text, extra), { chatId });
  const allow = new Set(cfg.telegramAllowFrom);
  // Pending approvals keyed by a per-request token: callback press -> resolver + the tracked
  // decision row the escalation opened (resolved when the button is pressed).
  const pending = new Map<string, { resolve: (decision: "allow" | "deny") => void; decisionId: string }>();
  // Remembers which project each sent worker message came from, so replying to a specific
  // message routes the follow-up back to that project (see send() + the reply handling below).
  // Ledger-backed so a mapping survives /reload — a lost route used to misroute the reply to the company.
  const routes = createMessageRoutes({ ledger, cacheCap: cfg.messageRoutesCacheCap });

  // Every worker-output line this bot sends goes through here, so `telegramToolSteps` applies on
  // every path (sessions, Telegram-started loops, company briefs, web mirrors) — not just send().
  const sendWorkerLine = (chatId: number, text: string, opts: { project?: string; priority?: Priority } = {}) =>
    sendFormatted(bot, chatId, text, { ...opts, toolSteps: cfg.telegramToolSteps });

  // Send a worker line and record which project it belongs to, so the operator can REPLY to that
  // specific message to route a follow-up into its project (see routeReply). The line itself is
  // a normal message, not a quote-reply. `chatId` is already the resolved TARGET surface (the
  // caller applied surfaceFor); the route is recorded on whichever chat the message actually
  // lands in, so a reply to it (in the DM or the Decisions chat) routes back to the right project.
  async function send(chatId: number, text: string, project?: string, priority?: Priority): Promise<void> {
    const messageId = await sendWorkerLine(chatId, text, { project, priority });
    if (messageId !== undefined && project) {
      const session = registry.findByName(project);
      if (session) routes.remember(chatId, messageId, { sessionId: session.id, folder: session.order.folder, project });
    }
  }

  // Resolve which chat a priority renders in (delegates to the pure routeChat rule): DECISION/ALERT/
  // RESULT → the Decisions group (or the DM if unset); PROGRESS/DONE → the DM firehose. `dm` is the
  // caller's intended chat. Defense in depth: even if `dm` IS the group (a session mistakenly homed
  // there), a firehose line still diverts to the admin DM — routine progress can never flood the group.
  const surfaceChat = (dm: number, priority?: Priority): number =>
    routeChat(priority, { cid: dm, adminDm: admin.adminId(), group: cfg.decisionsChatId });

  // Post a raised decision (from the `ask_operator` tool) to the operator's high-priority Decisions
  // channel with a tappable inline keyboard (option buttons + an "other / type an answer"
  // affordance). Registers the sent message in the reply-routing map so a plain REPLY to it also
  // resumes the raising project. Returns the sent message id so the engine can store it on the
  // decision row (a tap/reply then resolves that exact decision). Best-effort — a send failure just
  // means the decision stays queued (surfaced by the secretary digest / /decisions) with no channel post.
  async function postDecision(
    rec: { id: string; project?: string; folder?: string },
    question: string,
    options?: string[],
    spec?: StructuredAsk,
  ): Promise<{ chatId: number; messageId: number } | undefined> {
    const target = cfg.decisionsChatId ?? admin.adminId();
    if (target === undefined) return undefined; // no operator claimed yet — the queue still holds it
    const body = `${priorityBadge("decision")} ${projectTagPrefix(rec.project)}${question}`;
    // A structured ask (multi-select / multi-question) renders the richer keyboard; a flat single
    // choice keeps the legacy one-tap keyboard so its UX is unchanged.
    const keyboard = spec ? structuredKeyboard(rec.id, spec) : decisionKeyboard(rec.id, options);
    try {
      const m = await bot.api.sendMessage(target, body, { reply_markup: keyboard });
      // Wire a plain reply to this message back into the raising project (routeReply), when its
      // session is still around; if it's closed, the decision-answer path re-registers from the ledger.
      if (rec.folder) {
        const session = registry.findByFolder(rec.folder);
        if (session) routes.remember(target, m.message_id, { sessionId: session.id, folder: rec.folder, project: rec.project ?? session.name });
      }
      return { chatId: target, messageId: m.message_id };
    } catch {
      return undefined;
    }
  }

  // Register this surface as an operator sink: lines mirrored from the OTHER surface (the web
  // console) render in the admin's DM (admin.adminId()) or the Decisions chat by priority.
  // Output-only — never re-enters the pipeline.
  bus?.register(
    makeTelegramSink({
      adminId: () => admin.adminId(),
      decisionsChatId: () => cfg.decisionsChatId,
      reply: (cid, text, project, priority) => faults.contain("telegram.send", () => send(cid, text, project, priority), { project }),
      plain: (cid, text) => faults.contain("telegram.send", () => sendWorkerLine(cid, text)),
    }),
  );
  // Inbox items awaiting an operator-typed edit, keyed by chat id -> inbox item id (Slice 3).
  const pendingInboxEdit = new Map<number, string>();
  // Inbox items whose send is waiting on its Allow/Deny press — one send per item at a time.
  const sendingInbox = new Set<string>();
  // Decisions awaiting a typed "Other / type an answer", keyed by chat id -> decision id: the
  // operator tapped ✏️ on a raised decision, so their next message is the free-text answer.
  const pendingDecisionAnswer = new Map<number, string>();
  // In-progress selection for a STRUCTURED decision, keyed by decision id. Ephemeral UI state: the
  // decision row itself is durable, so a restart mid-selection just re-renders fresh from empty.
  const pendingStructuredSelection = new Map<string, Selection>();

  // Deliver an answer to a tracked decision and resume the project that raised it. One path behind
  // all three answer gestures — a plain REPLY to the decision message, a tapped option button, or a
  // typed "Other" answer: answerDecision marks the row answered (dropping it from /decisions + the
  // digest) and seeds a focused resume; we then run the pipeline so the blocked worker continues
  // with the answer. A decision with no resumable folder (e.g. an escalation) just gets acknowledged.
  async function answerAndResume(dec: DecisionRow, answer: string, chatId: number): Promise<void> {
    pendingStructuredSelection.delete(dec.id); // drop any in-progress selection — this decision is done
    const resumed = answerDecision({ registry, ledger, routes, worker: cfg.providers.ownWork }, dec, answer, chatId);
    // The acknowledgement stays in the chat the operator answered in (the group, when tapped there),
    // so they see confirmation where they acted. But the RESUME runs on the decision's ORIGINAL chat
    // (the DM) so the reopened session's progress flows to the muted firehose, never floods the group.
    await bot.api.sendMessage(chatId, `✅ answered — resuming ${dec.project ?? "the project"}.`);
    if (resumed) await handleMessage(resumed.brief, resumed.homeChat, pipelineDeps());
  }

  // Handle a tap on a raised decision's keyboard: an option, a Submit (structured), or "✏️ Other".
  // Thin wiring — the pure structured-question module owns the selection logic; a flat (legacy)
  // decision keeps its one-tap-resolves behavior. All three answer gestures end at answerAndResume.
  async function handleDecisionTap(ctx: Context, tap: DecisionTap): Promise<void> {
    const chatId = ctx.chat?.id ?? 0;
    const dec = ledger.decisionById(tap.id);
    if (!dec || dec.status !== "open") {
      await ctx.answerCallbackQuery("already answered");
      try {
        await ctx.editMessageReplyMarkup();
      } catch {
        // buttons already gone / "not modified" — ignore
      }
      return;
    }

    // "✏️ Other / type an answer": capture the operator's next message as a free-text answer.
    if (tap.kind === "other") {
      pendingDecisionAnswer.set(chatId, tap.id);
      await ctx.answerCallbackQuery();
      await bot.api.sendMessage(chatId, "✏️ Send your answer as your next message — I'll deliver it to the project.");
      return;
    }

    // A STRUCTURED decision (multi-select / multi-question): accumulate a selection; Submit resolves.
    if (dec.spec) {
      const ask = dec.spec;
      if (tap.kind === "submit") {
        const sel = pendingStructuredSelection.get(tap.id) ?? emptySelection(ask);
        if (!isComplete(ask, sel)) {
          await ctx.answerCallbackQuery("pick an option for each question");
          return;
        }
        await ctx.answerCallbackQuery("submitted");
        try {
          await ctx.editMessageReplyMarkup();
        } catch {
          // "not modified" — ignore
        }
        await answerAndResume(dec, answerText(ask, sel), chatId);
        return;
      }
      const sel = applyTap(ask, pendingStructuredSelection.get(tap.id) ?? emptySelection(ask), tap.qIdx, tap.optIdx);
      pendingStructuredSelection.set(tap.id, sel);
      // A single single-select question resolves on this one tap (today's UX — no Submit needed).
      if (!needsSubmit(ask) && isComplete(ask, sel)) {
        const answer = answerText(ask, sel);
        await ctx.answerCallbackQuery(`answered: ${answer.slice(0, 40)}`);
        try {
          await ctx.editMessageReplyMarkup();
        } catch {
          // "not modified" — ignore
        }
        await answerAndResume(dec, answer, chatId);
        return;
      }
      // Multi-select / multi-question: re-render the keyboard with the updated (✓) selection.
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: structuredKeyboard(tap.id, ask, sel) });
      } catch {
        // "not modified" — ignore
      }
      return;
    }

    // A FLAT (legacy) decision: options[] only. Submit doesn't apply; an option tap resolves directly.
    if (tap.kind === "submit") {
      await ctx.answerCallbackQuery();
      return;
    }
    const chosen = dec.options?.[tap.optIdx] ?? `option ${Number.isNaN(tap.optIdx) ? "?" : tap.optIdx}`;
    await ctx.answerCallbackQuery(`answered: ${chosen.slice(0, 40)}`);
    try {
      await ctx.editMessageReplyMarkup(); // drop the option buttons
    } catch {
      // "message is not modified" — ignore
    }
    await answerAndResume(dec, chosen, chatId);
  }

  // Gate: an optional pre-allowlist, then trust-on-first-use — the first allowed id to
  // message the bot becomes the sole admin (shared with the web console).
  const isOperator = (userId: number | undefined): userId is number =>
    userId !== undefined && !(allow.size > 0 && !allow.has(userId)) && admin.claimAdmin(userId);

  // Factory: build the full PipelineDeps object, closing over bot/pending/cfg/ledger/etc.
  // Used by both the message:text and file intake handlers so deps are never duplicated.
  const pipelineDeps = (): import("../engine/pipeline").PipelineDeps => ({
    cfg,
    ledger,
    registry,
    meter,
    usage,
    trust,
    lifecycle: reload?.lifecycle,
    cooldown: reload?.cooldown,
    codebaseMemory: sharedCodebaseMemoryIndexer(cfg),
    todo: reload?.todo,
    reply: (cid, text, project, priority) => {
      faults.contain("telegram.send", () => send(surfaceChat(cid, priority), text, project, priority), { project }); // routed + styled by priority
      bus?.mirror("telegram", { kind: "reply", text, project, priority }); // + mirror to the web console
    },
    postDecision, // lets the ask_operator tool post a tappable decision to the Decisions channel
    askApproval: (cid, reason) =>
      new Promise<"allow" | "deny">((resolve) => {
        const token = crypto.randomUUID();
        // Track the escalation as a DECISION so an ignored allow/deny still shows in /decisions + the
        // secretary digest and survives a restart (the in-memory resolver is lost on restart, but the
        // row stays OPEN — no silent loss). Best-effort project/folder attribution for grouping.
        const sess = registry.findByChat(cid);
        const decisionId = openEscalationDecision(ledger, { reason, project: sess?.name, folder: sess?.order.folder, chatId: cid });
        pending.set(token, { resolve, decisionId });
        const kb = new InlineKeyboard().text("Allow", `a:${token}`).text("Deny", `d:${token}`);
        // Route the blocking approval to the unmuted Decisions channel (falls back to the DM when
        // decisionsChatId is unset — today's behavior). The Allow/Deny buttons stay actionable here;
        // the web console just SEES the gate is pending.
        // An approval nobody can see can never be pressed: when the post fails, the gate fails CLOSED
        // (deny) and the fault is reported — the worker is never left waiting forever.
        bot.api
          .sendMessage(surfaceChat(cid, "decision"), `${priorityBadge("decision")} Approve this action?\n${reason}`, { reply_markup: kb })
          .catch((e) => {
            if (!pending.delete(token)) return;
            faults.guard("telegram.approval", () => resolveEscalationDecision(ledger, decisionId, "deny"));
            resolve("deny");
            faults.report("telegram.approval", e, { project: sess?.name, chatId: cid });
          });
        bus?.mirror("telegram", { kind: "notice", text: `⏳ approval pending: ${reason}` });
      }),
    sendFile: (cid, path, caption) =>
      faults.contain("telegram.sendFile", () => bot.api.sendDocument(cid, new InputFile(path), caption ? { caption } : {}), { chatId: cid }),
  });

  // Todo-queue releases that no dispatch is driving (the daemon tick, a resume, the restart) start
  // from the operator's own channel: the admin DM, with the same deps the company's dispatches use.
  reload?.todo?.setLauncher(() => {
    const chat = admin.adminId();
    return chat === undefined ? undefined : { deps: dispatchDepsFrom(pipelineDeps(), chat), replyChat: chat };
  });

  // Deps for running the company to draft a customer reply — identical to the web path: stream
  // progress back to this chat, and auto-deny risky tools (customer work never auto-approves).
  const briefDeps = (chatId: number): IngressDeps => ({
    cfg,
    ledger,
    registry,
    meter,
    usage,
    trust,
    // runCompanyBrief replies on the internal CUSTOMER_CHAT id; ignore it and stream to the
    // operator's chat (the web path likewise ignores the cid and notifies its own channel).
    reply: (_cid, text, project) => faults.contain("telegram.send", () => sendWorkerLine(chatId, text, { project }), { project }),
    askApproval: async () => "deny",
  });

  // Receive a document or photo from the operator: save to the active project's inbox,
  // then feed an augmented message to the pipeline so the worker knows the file arrived.
  async function intakeFile(ctx: any, name: string, captionText: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!isOperator(userId)) return;
    const chatId = ctx.chat.id;
    // A reply on the attachment targets that project; resolve it (focus, or clarify) before saving.
    const routing = routeReply(
      { registry, ledger, routes, worker: cfg.providers.ownWork },
      {
        chatId,
        replyToMessageId: ctx.message?.reply_to_message?.message_id,
        replyToText: ctx.message?.reply_to_message?.text,
        text: captionText,
      },
    );
    if ("clarify" in routing) {
      say(chatId, routing.clarify);
      return;
    }
    const target = registry.findByChat(chatId) ?? registry.getDefault();
    if (!target) {
      say(chatId, "No active project to receive the file.");
      return;
    }
    const file = await ctx.getFile();
    const bytes = await downloadTelegramFile(cfg.telegramToken, file.file_path!);
    const path = saveInbound(target.order.folder, name, bytes);
    await handleMessage(
      `📎 operator attached \`${name}\` at \`${path}\`\n${routing.deliver}`,
      chatId,
      pipelineDeps(),
    );
  }

  on.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isOperator(userId)) return;
    const chatId = ctx.chat.id;

    // A pending inbox edit takes the next message as the revised reply (not an order/command).
    const editId = pendingInboxEdit.get(chatId);
    if (editId !== undefined && inbox) {
      pendingInboxEdit.delete(chatId);
      const item = inbox.get(editId);
      if (!item) {
        say(chatId, "That message is no longer in the inbox.");
        return;
      }
      inbox.setDraft(editId, ctx.message.text); // stages the edited reply (status stays 'drafted')
      const view = renderInboxItem(inbox, editId)!;
      say(chatId, view.text, { reply_markup: inboxItemKeyboard(editId, view.item.status)! });
      return;
    }

    // A pending "Other / type an answer" for a raised decision takes this message as the answer
    // (not an order/command): resolve the decision and resume the project that raised it.
    const answerDecId = pendingDecisionAnswer.get(chatId);
    if (answerDecId !== undefined) {
      pendingDecisionAnswer.delete(chatId);
      const dec = ledger.decisionById(answerDecId);
      if (dec && dec.status === "open") await answerAndResume(dec, ctx.message.text, chatId);
      else say(chatId, "That decision is no longer open.");
      return;
    }

    // Bare /loop → tappable run buttons; /loop <name> starts a background loop (streams progress).
    if (ctx.message.text.trim() === "/loop") {
      const kb = new InlineKeyboard();
      for (const l of listLoops(ledger)) kb.text(`▶ ${l.usage.replace("/loop ", "")}`, `runloop:${l.name}`).row();
      say(chatId, "Run a loop:", { reply_markup: kb });
      return;
    }
    if (
      handleLoop(ctx.message.text, chatId, {
        reply: (cid, t) => faults.contain("telegram.send", () => sendWorkerLine(cid, t)),
        store: ledger,
        shouldStop: () => meter.shouldThrottleBackground(),
        cfg,
      })
    )
      return;

    // Engine commands (/list, /kill, /help, …) resolve synchronously; everything else is an
    // order or a follow-up handled by the pipeline.
    const command = handleCommand(ctx.message.text, chatId, {
      registry,
      ledger,
      usage,
      trust,
      inbox,
      requestReload: reload?.requestReload,
      cfg,
      windowTokensByModel: cfg.contextPolicy.windowTokensByModel,
      todo: reload?.todo,
      updates: reload?.updates,
    });
    if (command !== null) {
      if (command.select?.length) {
        say(chatId, command.text, { reply_markup: projectKeyboard(command.select) });
      } else if (command.inbox?.length) {
        say(chatId, command.text, { reply_markup: inboxKeyboard(command.inbox) });
      } else {
        say(chatId, command.text);
      }
      return;
    }

    // If the operator REPLIED to a tracked decision's channel message, that reply IS the answer:
    // resolve it and resume the raising project. Checked before routeReply — the decision row carries
    // its own resume target (folder), so nothing blocking is ever lost to a generic reply route.
    const replyToId = ctx.message.reply_to_message?.message_id;
    if (replyToId !== undefined) {
      const dec = ledger.decisionByMessage(chatId, replyToId);
      if (dec && dec.status === "open" && dec.kind === "decision") {
        await answerAndResume(dec, ctx.message.text, chatId);
        return;
      }
    }

    // If the operator replied to a specific worker message, route this follow-up to that project.
    // An unattributable reply is NOT silently sent to the company — we ask them to name the project.
    const routing = routeReply(
      { registry, ledger, routes, worker: cfg.providers.ownWork },
      {
        chatId,
        replyToMessageId: ctx.message.reply_to_message?.message_id,
        replyToText: ctx.message.reply_to_message?.text,
        text: ctx.message.text,
      },
    );
    if ("clarify" in routing) {
      say(chatId, routing.clarify);
      return;
    }
    // Echo the operator's own message to the web console so both surfaces show the thread. Only
    // real conversation/orders reach here — commands returned above. Telegram already shows the
    // sent message, so origin "telegram" is excluded from the fan-out.
    bus?.mirror("telegram", { kind: "echo", text: ctx.message.text });
    await handleMessage(routing.deliver, chatId, pipelineDeps());
  });

  on.on("message:document", (ctx) =>
    intakeFile(
      ctx,
      ctx.message.document.file_name ?? `file-${ctx.message.document.file_unique_id}`,
      ctx.message.caption ?? "",
    ),
  );
  on.on("message:photo", (ctx) => {
    const photo = ctx.message.photo.at(-1)!; // largest size
    return intakeFile(ctx, `photo-${photo.file_unique_id}.jpg`, ctx.message.caption ?? "");
  });

  on.on("callback_query:data", async (ctx) => {
    if (!admin.isAdmin(ctx.from?.id ?? -1)) {
      await ctx.answerCallbackQuery();
      return;
    }

    // Tap a project to make it active (use:) or kill it (kill:) — shared engine functions.
    const cb = ctx.callbackQuery.data;
    if (cb.startsWith("use:") || cb.startsWith("kill:")) {
      const id = cb.slice(cb.indexOf(":") + 1);
      const chatId = ctx.chat?.id ?? 0;
      const result = cb.startsWith("use:")
        ? selectProject(id, chatId, { registry, ledger, usage, trust, windowTokensByModel: cfg.contextPolicy.windowTokensByModel })
        : killProject(id, chatId, { registry, ledger, usage, trust, windowTokensByModel: cfg.contextPolicy.windowTokensByModel });
      await ctx.answerCallbackQuery(cb.startsWith("use:") ? "switched" : "killed");
      try {
        await ctx.editMessageText(
          result.text,
          result.select?.length ? { reply_markup: projectKeyboard(result.select) } : undefined,
        );
      } catch {
        // "message is not modified" — ignore
      }
      return;
    }

    // Tap an inbox row to view the full customer message (plain data — no AI).
    if (cb.startsWith("inbox:")) {
      const id = cb.slice("inbox:".length);
      const view = inbox ? renderInboxItem(inbox, id) : undefined;
      await ctx.answerCallbackQuery();
      if (!view) {
        await ctx.reply("That message is no longer in the inbox.");
        return;
      }
      const kb = inboxItemKeyboard(view.item.id, view.item.status);
      await ctx.reply(view.text, kb ? { reply_markup: kb } : undefined);
      return;
    }

    // Send an inbox item to the company to draft a reply (same logic as POST /api/inbox/draft).
    if (cb.startsWith("inbox-draft:")) {
      const id = cb.slice("inbox-draft:".length);
      const chatId = ctx.chat?.id ?? 0;
      await ctx.answerCallbackQuery("drafting…");
      if (!inbox) return;
      await ctx.editMessageReplyMarkup(); // drop the button while the company drafts
      say(chatId, "⏳ the company is drafting a reply…");
      // Drafting is a whole company run (minutes). Updates are handled one at a time, so it runs
      // detached as its own unit — the bot keeps answering while the company drafts.
      faults.contain(
        "telegram.inboxDraft",
        async () => {
          const draft = await draftInboxReply(inbox, id, "", briefDeps(chatId));
          if (draft === undefined) {
            await bot.api.sendMessage(chatId, "That message is no longer in the inbox.");
            return;
          }
          const view = renderInboxItem(inbox, id);
          if (view) {
            const kb = inboxItemKeyboard(view.item.id, view.item.status);
            await bot.api.sendMessage(chatId, view.text, kb ? { reply_markup: kb } : undefined);
          }
        },
        { item: id },
      );
      return;
    }

    // Edit the draft: capture the operator's next text message as the revised reply.
    if (cb.startsWith("inbox-edit:")) {
      const id = cb.slice("inbox-edit:".length);
      const chatId = ctx.chat?.id ?? 0;
      await ctx.answerCallbackQuery();
      if (!inbox || !inbox.get(id)) {
        await ctx.reply("That message is no longer in the inbox.");
        return;
      }
      pendingInboxEdit.set(chatId, id);
      await bot.api.sendMessage(chatId, "✏️ Send the revised reply as your next message — I'll stage it for sending.");
      return;
    }

    // Send the approved reply to the customer (same path as POST /api/inbox/send). Sending to a
    // real person is an external action, so it goes through the engine's Allow/Deny approval gate.
    if (cb.startsWith("inbox-send:")) {
      const id = cb.slice("inbox-send:".length);
      const chatId = ctx.chat?.id ?? 0;
      await ctx.answerCallbackQuery();
      const view = inbox ? renderInboxItem(inbox, id) : undefined;
      const url = gatewaySendUrl;
      const secret = cfg.agentIngressSecret;
      if (!inbox || !view || !url || !secret) {
        await bot.api.sendMessage(chatId, "Can't send — the gateway isn't configured or the item is gone.");
        return;
      }
      if (view.item.status === "replied") {
        await bot.api.sendMessage(chatId, `Already replied to ${view.item.from}.`);
        return;
      }
      if (sendingInbox.has(id)) {
        await bot.api.sendMessage(chatId, "A send for this message is already waiting for approval.");
        return;
      }
      if (!view.item.draft.trim()) {
        await bot.api.sendMessage(chatId, "Nothing to send yet — draft a reply first.");
        return;
      }
      try {
        await ctx.editMessageReplyMarkup(); // drop the buttons while the send waits for approval
      } catch {
        // "message is not modified" — ignore
      }
      // The approval is answered by a LATER update (the Allow/Deny press). Updates are handled one at a
      // time, so awaiting it here would hold the very update queue that press must arrive through —
      // a deadlock. The wait runs detached; this handler returns at once. One approval per item at a
      // time; the send names the draft version the operator approved, so an edit made meanwhile (or a
      // send that already went out) is refused, never sent unseen.
      const approved = { draft: view.item.draft, version: view.item.draftVersion };
      sendingInbox.add(id);
      faults.contain(
        "telegram.inboxSend",
        async () => {
          try {
            const decision = await pipelineDeps().askApproval(chatId, `Send this reply to ${view.item.from}?\n\n${approved.draft}`);
            if (decision !== "allow") {
              await bot.api.sendMessage(chatId, "Send cancelled.");
              return;
            }
            const outcome = await sendInboxReply(inbox, id, approved.draft, { url, secret }, fetch, { draftVersion: approved.version });
            await bot.api.sendMessage(chatId, INBOX_SEND_RESULT[outcome](view.item.from));
          } finally {
            sendingInbox.delete(id);
          }
        },
        { item: id },
      );
      return;
    }

    // Tap a loop run button.
    if (cb.startsWith("runloop:")) {
      const loop = matchLoop(cb.slice("runloop:".length), ledger);
      await ctx.answerCallbackQuery(loop ? "running" : "unknown loop");
      if (loop)
        launchLoop(loop, ctx.chat?.id ?? 0, {
          reply: (cid, t) => faults.contain("telegram.send", () => sendWorkerLine(cid, t)),
          store: ledger,
          shouldStop: () => meter.shouldThrottleBackground(),
          cfg,
        });
      return;
    }

    // Tap on a raised decision's keyboard — an option, a Submit (structured multi-select /
    // multi-question), or "✏️ Other" (free-form). All decision callbacks parse here (backward
    // compatible with the legacy flat `dec:<id>:<idx>`); the pure structured-question module owns the
    // selection logic, so this stays thin I/O wiring.
    const tap = parseDecisionCallback(cb);
    if (tap) {
      await handleDecisionTap(ctx, tap);
      return;
    }

    const [kind, token] = ctx.callbackQuery.data.split(":");
    const pend = token ? pending.get(token) : undefined;
    if (pend) {
      pending.delete(token);
      const verdict = kind === "a" ? "allow" : "deny";
      pend.resolve(verdict); // unblock the waiting worker
      resolveEscalationDecision(ledger, pend.decisionId, verdict); // close the tracked decision row
      bus?.mirror("telegram", { kind: "notice", text: `approval ${verdict} on Telegram` });
      await ctx.answerCallbackQuery(verdict === "allow" ? "Allowed" : "Denied");
      await ctx.editMessageReplyMarkup(); // drop the buttons
    } else {
      await ctx.answerCallbackQuery();
    }
  });

  return bot;
}

/** What the operator is told after a Send, per outcome (inbox-actions `InboxSendOutcome`). */
const INBOX_SEND_RESULT: Record<InboxSendOutcome, (to: string) => string> = {
  sent: (to) => `✅ replied to ${to}.`,
  failed: () => "⚠️ send failed — the reply was not delivered.",
  stale: () => "Not sent — the draft changed or was already sent while it waited. Tap Send again.",
  busy: () => "Not sent — a send for this message is already in progress.",
};

export function startTelegram(...args: Parameters<typeof createTelegramBot>): Bot {
  const bot = createTelegramBot(...args);
  // Publish the "/" command menu so Telegram autocompletes the operator's commands (Telegram only
  // shows the list for commands the bot has registered). Best-effort + fire-and-forget so a Bot API
  // hiccup can't stop the bot from starting.
  faults.contain("telegram.commands", () => registerTelegramCommands(bot));
  superviseTelegramPolling(() => bot.start(), {
    report: (e) => faults.report("telegram.polling", e),
    exit: (code) => {
      console.error("[telegram] long polling stopped for good — exiting so the supervisor restarts Neo");
      setTimeout(() => process.exit(code), 1_000).unref();
    },
  });
  return bot;
}

/** Publish the engine's command list to Telegram so typing "/" shows the autocomplete menu. The
 *  list is derived from the COMMANDS registry (telegramCommands()), so new commands appear
 *  automatically. Only re-sends when the list actually changed (a cheap getMyCommands diff, so a
 *  restart is a no-op when nothing changed). Best-effort: any Bot API failure is logged and
 *  swallowed — registering the menu must never break bot startup. */
export async function registerTelegramCommands(bot: Bot): Promise<void> {
  const desired = telegramCommands();
  try {
    const current = await bot.api.getMyCommands();
    if (commandsEqual(current, desired)) return; // already up to date — skip the write
    await bot.api.setMyCommands(desired);
  } catch (err) {
    console.error("[telegram] failed to register the / command menu:", err);
  }
}

function commandsEqual(a: { command: string; description: string }[], b: TelegramCommand[]): boolean {
  return a.length === b.length && a.every((c, i) => c.command === b[i]!.command && c.description === b[i]!.description);
}

/** The inline keyboard for a raised decision: one tappable button per option (`dec:<id>:<idx>`),
 *  then an "✏️ Other / type an answer" affordance (`deco:<id>`) that captures the operator's next
 *  message as a free-text answer. A free-form question (no options) shows just the Other button —
 *  the operator can also simply REPLY to the message. Kept pure/exported so it's unit-testable. */
export function decisionKeyboard(id: string, options?: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Cap at 8 options so the callback data stays well under Telegram's 64-byte limit and the keyboard
  // stays tappable; each on its own row since option labels can be long.
  if (options?.length) options.slice(0, 8).forEach((label, i) => kb.text(label.slice(0, 60), `dec:${id}:${i}`).row());
  kb.text("✏️ Other / type an answer", `deco:${id}`);
  return kb;
}

/** Build the inline keyboard for a STRUCTURED decision (Feature 1) from the pure keyboard spec:
 *  option buttons (checkmarked when selected), a "✅ Submit" when the ask needs one (multi-select /
 *  multi-question), and the "✏️ Other" free-form affordance last. `sel` shows the in-progress picks.
 *  Kept pure/exported (the module owns the layout) so it's unit-testable without a Bot. */
export function structuredKeyboard(id: string, ask: StructuredAsk, sel?: Selection): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of keyboardRows(id, ask, sel)) {
    for (const btn of row) kb.text(btn.label, btn.data);
    kb.row();
  }
  return kb;
}

/** One button per open project; the active one is starred. Tapping fires a `use:<id>` callback. */
function projectKeyboard(select: SelectableProject[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of select) kb.text(p.active ? `★ ${p.label}` : p.label, `use:${p.id}`).text("✕", `kill:${p.id}`).row();
  return kb;
}

/** One button per inbox row; tapping fires `inbox:<id>` to open the full message. */
function inboxKeyboard(items: InboxListEntry[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const i of items) kb.text(i.label.slice(0, 60), `inbox:${i.id}`).row();
  return kb;
}

/** Per-item action buttons, gated by status — mirrors the web review loop's per-row actions.
 *  Returns undefined when a status offers no actions (e.g. while drafting or once replied). */
function inboxItemKeyboard(id: string, status: string): InlineKeyboard | undefined {
  if (status === "new") return new InlineKeyboard().text("🤖 Send to agent", `inbox-draft:${id}`);
  if (status === "drafted")
    return new InlineKeyboard()
      .text("✏️ Edit", `inbox-edit:${id}`)
      .text("📤 Send", `inbox-send:${id}`)
      .row()
      .text("↩ Re-draft", `inbox-draft:${id}`);
  return undefined;
}

/** A stop of long polling that no retry can fix: a revoked token (401) or another poller on the same
 *  token (409). grammy retries everything else inside getUpdates itself. */
export function pollingStopIsUnrecoverable(err: unknown): boolean {
  return err instanceof GrammyError && (err.error_code === 401 || err.error_code === 409);
}

/** Keep long polling alive (ADR-0010). `start` rejects when polling stops: an unrecoverable stop is
 *  an UNRECOVERABLE STATE — a daemon that cannot hear the operator — so it is reported and the process
 *  exits for the supervisor. Any other stop (a network error on the startup getMe) is reported and
 *  polling restarts after a backoff; the last `retryMs` step repeats. A clean stop does nothing. */
export function superviseTelegramPolling(
  start: () => Promise<void>,
  deps: { report: (e: unknown) => void; exit: (code: number) => void; sleep?: (ms: number) => Promise<void>; retryMs?: number[] },
): void {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ladder = deps.retryMs ?? [5_000, 30_000, 120_000];
  const run = async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await start();
        return;
      } catch (e) {
        deps.report(e);
        if (pollingStopIsUnrecoverable(e)) return deps.exit(1);
        await sleep(ladder[Math.min(attempt, ladder.length - 1)]);
      }
    }
  };
  void run().catch((e) => deps.report(e)); // report/exit/sleep throwing must not become a rejection
}

