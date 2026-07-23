// The channel you talk to projects through. Thin grammy glue over the engine pipeline:
// it translates Telegram updates into handleOrder() calls and renders escalations as
// Allow/Deny inline buttons. All the logic lives in engine/pipeline.ts (tested); this
// file is I/O wiring, verified at the daemon e2e step.
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { saveInbound } from "../engine/files";
import type { NeoConfig } from "../config";
import type { Ledger } from "../engine/ledger";
import type { Registry } from "../engine/registry";
import type { Meter } from "../engine/budget";
import type { AdminStore } from "../engine/admin";
import type { UsageMeter } from "../engine/usage";
import type { TrustStore } from "../engine/trust";
import type { Inbox } from "../engine/inbox";
import { createRegistry } from "../engine/registry";
import { createMeter } from "../engine/budget";
import { openTrustStore } from "../engine/trust";
import { handleMessage } from "../engine/pipeline";
import { sharedCodebaseMemoryIndexer } from "../engine/codebase-memory";
import { createMessageRoutes } from "../engine/message-routes";
import { routeReply } from "../engine/reply-routing";
import { handleCommand, selectProject, killProject, telegramCommands, type SelectableProject, type TelegramCommand } from "../engine/commands";
import { handleLoop, listLoops, matchLoop, startLoop } from "../engine/loops";
import { renderInboxItem, draftInboxReply, sendInboxReply, type InboxListEntry } from "../engine/inbox-actions";
import type { IngressDeps } from "../engine/ingress";
import { mdToHtml, projectHashtag } from "../engine/format";
import type { OperatorBus, OperatorSink } from "../engine/operator-bus";
import type { ApiCooldown } from "../engine/api-retry";

/** Prefix for every project-attributed outbound line: a clickable Telegram hashtag
 *  (#waselni, #eticket_v3, ...) so tapping it filters the chat to that project. Kept as plain
 *  text — never wrapped in <code>/<pre> — so Telegram auto-links it under parse_mode HTML too. */
export function projectTagPrefix(project?: string): string {
  return project ? `${projectHashtag(project)} ` : "";
}

/** Build the Telegram operator sink (pure — no Bot instance, so it's unit-testable). Lines mirrored
 *  from the OTHER surface (the web console) render in the admin's DM: a `reply` as project-tagged
 *  worker output, an `echo` as the operator's own web-typed message, a `notice` as display-only
 *  chrome (e.g. an approval pending on the web). Output-only — it never re-enters the pipeline, so a
 *  mirrored line can't become an order (see operator-bus.ts). No admin claimed yet → no-op. */
export function makeTelegramSink(deps: {
  adminId: () => number | undefined;
  reply: (chatId: number, text: string, project?: string) => void;
  plain: (chatId: number, text: string) => void;
}): OperatorSink {
  return {
    id: "telegram",
    deliver: (line) => {
      const chatId = deps.adminId();
      if (chatId === undefined) return; // nowhere to deliver — no operator has claimed admin yet
      if (line.kind === "reply") deps.reply(chatId, line.text, line.project);
      else if (line.kind === "echo") deps.plain(chatId, `🌐 you (web): ${line.text}`);
      else deps.plain(chatId, line.text);
    },
  };
}

async function downloadTelegramFile(token: string, filePath: string): Promise<Uint8Array> {
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Send worker output as formatted HTML (bold/code/bullets), falling back to plain text if
 *  Telegram rejects the markup. `project` tags which project the line came from. Returns the sent
 *  message id (so the caller can route a later reply back to the right session), or undefined if
 *  the send failed. Worker output is sent as plain messages — NOT quote-replies to the operator's
 *  order — so a streamed run doesn't show every line threaded under one old message. */
async function sendFormatted(
  bot: Bot,
  chatId: number,
  text: string,
  project?: string,
): Promise<number | undefined> {
  const tag = projectTagPrefix(project);
  try {
    const m = await bot.api.sendMessage(chatId, tag + mdToHtml(text, { tables: "pre" }), { parse_mode: "HTML" });
    return m.message_id;
  } catch {
    try {
      const m = await bot.api.sendMessage(chatId, tag + text);
      return m.message_id;
    } catch {
      // give up silently — a dropped progress line shouldn't crash the bot
      return undefined;
    }
  }
}

/** Post a single line to the operator's chat over the raw Bot API (no grammy Bot instance needed),
 *  project-tagged + HTML-formatted with a plain-text fallback — the same #project style as streamed
 *  worker/dispatch output. Used by the daemon's loop scheduler so scheduled-loop worker output
 *  reaches the operator's Telegram channel, not just daemon stdout. A dropped line never throws. */
export async function sendOperatorLine(token: string, chatId: number, text: string, project?: string): Promise<void> {
  const tag = projectTagPrefix(project);
  const post = (body: string, html: boolean): Promise<Response> =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: body, ...(html ? { parse_mode: "HTML" } : {}) }),
    });
  try {
    const r = await post(tag + mdToHtml(text, { tables: "pre" }), true);
    if (!r.ok) await post(tag + text, false); // Telegram rejected the markup — resend as plain text
  } catch {
    // a dropped loop line must never crash the daemon
  }
}

export function startTelegram(
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
  reload?: { lifecycle?: { draining(): boolean }; requestReload?: () => void; cooldown?: ApiCooldown },
  /** Operator-channel broadcast bus — mirror this surface to the web console and vice-versa. */
  bus?: OperatorBus,
): Bot {
  const bot = new Bot(cfg.telegramToken);
  const allow = new Set(cfg.telegramAllowFrom);
  // Pending approvals keyed by a per-request token: callback press -> resolver.
  const pending = new Map<string, (decision: "allow" | "deny") => void>();
  // Remembers which project each sent worker message came from, so replying to a specific
  // message routes the follow-up back to that project (see send() + the reply handling below).
  // Ledger-backed so a mapping survives /reload — a lost route used to misroute the reply to the company.
  const routes = createMessageRoutes({ ledger });

  // Send a worker line and record which project it belongs to, so the operator can REPLY to that
  // specific message to route a follow-up into its project (see routeReply). The line itself is
  // a normal message, not a quote-reply.
  async function send(chatId: number, text: string, project?: string): Promise<void> {
    const messageId = await sendFormatted(bot, chatId, text, project);
    if (messageId !== undefined && project) {
      const session = registry.findByName(project);
      if (session) routes.remember(chatId, messageId, { sessionId: session.id, folder: session.order.folder, project });
    }
  }

  // Register this surface as an operator sink: lines mirrored from the OTHER surface (the web
  // console) render in the admin's DM (admin.adminId()). Output-only — never re-enters the pipeline.
  bus?.register(
    makeTelegramSink({
      adminId: () => admin.adminId(),
      reply: (cid, text, project) => void send(cid, text, project),
      plain: (cid, text) => void sendFormatted(bot, cid, text),
    }),
  );
  // Inbox items awaiting an operator-typed edit, keyed by chat id -> inbox item id (Slice 3).
  const pendingInboxEdit = new Map<number, string>();

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
    reply: (cid, text, project) => {
      void send(cid, text, project); // local delivery (unchanged)
      bus?.mirror("telegram", { kind: "reply", text, project }); // + mirror to the web console
    },
    askApproval: (cid, reason) =>
      new Promise<"allow" | "deny">((resolve) => {
        const token = crypto.randomUUID();
        pending.set(token, resolve);
        const kb = new InlineKeyboard().text("Allow", `a:${token}`).text("Deny", `d:${token}`);
        void bot.api.sendMessage(cid, `⚠️ Approve this action?\n${reason}`, { reply_markup: kb });
        // The actionable buttons stay here; the web console just SEES the gate is pending.
        bus?.mirror("telegram", { kind: "notice", text: `⏳ approval pending on Telegram: ${reason}` });
      }),
    sendFile: (cid, path, caption) =>
      void bot.api.sendDocument(cid, new InputFile(path), caption ? { caption } : {}),
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
    reply: (_cid, text, project) => void sendFormatted(bot, chatId, text, project),
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
      { registry, ledger, routes },
      {
        chatId,
        replyToMessageId: ctx.message?.reply_to_message?.message_id,
        replyToText: ctx.message?.reply_to_message?.text,
        text: captionText,
      },
    );
    if ("clarify" in routing) {
      void bot.api.sendMessage(chatId, routing.clarify);
      return;
    }
    const target = registry.findByChat(chatId) ?? registry.getDefault();
    if (!target) {
      void bot.api.sendMessage(chatId, "No active project to receive the file.");
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

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isOperator(userId)) return;
    const chatId = ctx.chat.id;

    // A pending inbox edit takes the next message as the revised reply (not an order/command).
    const editId = pendingInboxEdit.get(chatId);
    if (editId !== undefined && inbox) {
      pendingInboxEdit.delete(chatId);
      const item = inbox.get(editId);
      if (!item) {
        void bot.api.sendMessage(chatId, "That message is no longer in the inbox.");
        return;
      }
      inbox.setDraft(editId, ctx.message.text); // stages the edited reply (status stays 'drafted')
      const view = renderInboxItem(inbox, editId)!;
      void bot.api.sendMessage(chatId, view.text, { reply_markup: inboxItemKeyboard(editId, view.item.status)! });
      return;
    }

    // Bare /loop → tappable run buttons; /loop <name> starts a background loop (streams progress).
    if (ctx.message.text.trim() === "/loop") {
      const kb = new InlineKeyboard();
      for (const l of listLoops(ledger)) kb.text(`▶ ${l.usage.replace("/loop ", "")}`, `runloop:${l.name}`).row();
      void bot.api.sendMessage(chatId, "Run a loop:", { reply_markup: kb });
      return;
    }
    if (
      handleLoop(ctx.message.text, chatId, {
        reply: (cid, t) => void bot.api.sendMessage(cid, t),
        store: ledger,
        shouldStop: () => meter.shouldThrottle(),
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
      windowTokensByModel: cfg.contextPolicy.windowTokensByModel,
    });
    if (command !== null) {
      if (command.select?.length) {
        void bot.api.sendMessage(chatId, command.text, { reply_markup: projectKeyboard(command.select) });
      } else if (command.inbox?.length) {
        void bot.api.sendMessage(chatId, command.text, { reply_markup: inboxKeyboard(command.inbox) });
      } else {
        void bot.api.sendMessage(chatId, command.text);
      }
      return;
    }

    // If the operator replied to a specific worker message, route this follow-up to that project.
    // An unattributable reply is NOT silently sent to the company — we ask them to name the project.
    const routing = routeReply(
      { registry, ledger, routes },
      {
        chatId,
        replyToMessageId: ctx.message.reply_to_message?.message_id,
        replyToText: ctx.message.reply_to_message?.text,
        text: ctx.message.text,
      },
    );
    if ("clarify" in routing) {
      void bot.api.sendMessage(chatId, routing.clarify);
      return;
    }
    // Echo the operator's own message to the web console so both surfaces show the thread. Only
    // real conversation/orders reach here — commands returned above. Telegram already shows the
    // sent message, so origin "telegram" is excluded from the fan-out.
    bus?.mirror("telegram", { kind: "echo", text: ctx.message.text });
    await handleMessage(routing.deliver, chatId, pipelineDeps());
  });

  bot.on("message:document", (ctx) =>
    intakeFile(
      ctx,
      ctx.message.document.file_name ?? `file-${ctx.message.document.file_unique_id}`,
      ctx.message.caption ?? "",
    ),
  );
  bot.on("message:photo", (ctx) => {
    const photo = ctx.message.photo.at(-1)!; // largest size
    return intakeFile(ctx, `photo-${photo.file_unique_id}.jpg`, ctx.message.caption ?? "");
  });

  bot.on("callback_query:data", async (ctx) => {
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
      void bot.api.sendMessage(chatId, "⏳ the company is drafting a reply…");
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
      if (!view || !gatewaySendUrl || !cfg.agentIngressSecret) {
        await bot.api.sendMessage(chatId, "Can't send — the gateway isn't configured or the item is gone.");
        return;
      }
      const reply = view.item.draft;
      if (!reply.trim()) {
        await bot.api.sendMessage(chatId, "Nothing to send yet — draft a reply first.");
        return;
      }
      const decision = await pipelineDeps().askApproval(chatId, `Send this reply to ${view.item.from}?\n\n${reply}`);
      if (decision !== "allow") {
        await bot.api.sendMessage(chatId, "Send cancelled.");
        return;
      }
      const sent = await sendInboxReply(inbox!, id, reply, { url: gatewaySendUrl, secret: cfg.agentIngressSecret });
      await bot.api.sendMessage(chatId, sent ? `✅ replied to ${view.item.from}.` : "⚠️ send failed — the reply was not delivered.");
      return;
    }

    // Tap a loop run button.
    if (cb.startsWith("runloop:")) {
      const loop = matchLoop(cb.slice("runloop:".length), ledger);
      await ctx.answerCallbackQuery(loop ? "running" : "unknown loop");
      if (loop)
        void startLoop(loop, ctx.chat?.id ?? 0, {
          reply: (cid, t) => void bot.api.sendMessage(cid, t),
          store: ledger,
          shouldStop: () => meter.shouldThrottle(),
          cfg,
        });
      return;
    }

    const [kind, token] = ctx.callbackQuery.data.split(":");
    const resolve = token ? pending.get(token) : undefined;
    if (resolve) {
      pending.delete(token);
      resolve(kind === "a" ? "allow" : "deny");
      bus?.mirror("telegram", { kind: "notice", text: `approval ${kind === "a" ? "allow" : "deny"} on Telegram` });
      await ctx.answerCallbackQuery(kind === "a" ? "Allowed" : "Denied");
      await ctx.editMessageReplyMarkup(); // drop the buttons
    } else {
      await ctx.answerCallbackQuery();
    }
  });

  // Publish the "/" command menu so Telegram autocompletes the operator's commands (Telegram only
  // shows the list for commands the bot has registered). Best-effort + fire-and-forget so a Bot API
  // hiccup can't stop the bot from starting.
  void registerTelegramCommands(bot);
  void bot.start();
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
