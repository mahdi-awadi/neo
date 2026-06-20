// The channel you talk to projects through. Thin grammy glue over the engine pipeline:
// it translates Telegram updates into handleOrder() calls and renders escalations as
// Allow/Deny inline buttons. All the logic lives in engine/pipeline.ts (tested); this
// file is I/O wiring, verified at the daemon e2e step.
import { Bot, InlineKeyboard } from "grammy";
import type { NeoConfig } from "../config";
import type { Ledger } from "../engine/ledger";
import type { Registry } from "../engine/registry";
import type { Meter } from "../engine/budget";
import type { AdminStore } from "../engine/admin";
import type { UsageMeter } from "../engine/usage";
import { createRegistry } from "../engine/registry";
import { createMeter } from "../engine/budget";
import { handleMessage } from "../engine/pipeline";
import { handleCommand, selectProject, type SelectableProject } from "../engine/commands";
import { handleLoop } from "../engine/loops";

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
  usage?: UsageMeter,
): Bot {
  const bot = new Bot(cfg.telegramToken);
  const allow = new Set(cfg.telegramAllowFrom);
  // Pending approvals keyed by a per-request token: callback press -> resolver.
  const pending = new Map<string, (decision: "allow" | "deny") => void>();

  // Gate: an optional pre-allowlist, then trust-on-first-use — the first allowed id to
  // message the bot becomes the sole admin (shared with the web console).
  const isOperator = (userId: number | undefined): userId is number =>
    userId !== undefined && !(allow.size > 0 && !allow.has(userId)) && admin.claimAdmin(userId);

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isOperator(userId)) return;
    const chatId = ctx.chat.id;

    // /loop runs a long verifiable loop in the background (streams its own progress).
    if (handleLoop(ctx.message.text, chatId, { reply: (cid, t) => void bot.api.sendMessage(cid, t) })) return;

    // Engine commands (/list, /kill, /help, …) resolve synchronously; everything else is an
    // order or a follow-up handled by the pipeline.
    const command = handleCommand(ctx.message.text, chatId, { registry, ledger, usage });
    if (command !== null) {
      if (command.select?.length) {
        void bot.api.sendMessage(chatId, command.text, { reply_markup: projectKeyboard(command.select) });
      } else {
        void bot.api.sendMessage(chatId, command.text);
      }
      return;
    }

    await handleMessage(ctx.message.text, chatId, {
      cfg,
      ledger,
      registry,
      meter,
      usage,
      reply: (cid, text) => void bot.api.sendMessage(cid, text),
      askApproval: (cid, reason) =>
        new Promise<"allow" | "deny">((resolve) => {
          const token = crypto.randomUUID();
          pending.set(token, resolve);
          const kb = new InlineKeyboard().text("Allow", `a:${token}`).text("Deny", `d:${token}`);
          void bot.api.sendMessage(cid, `⚠️ Approve this action?\n${reason}`, { reply_markup: kb });
        }),
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    if (!admin.isAdmin(ctx.from?.id ?? -1)) {
      await ctx.answerCallbackQuery();
      return;
    }

    // Tap a project in /list to make it active (the shared engine selectProject).
    if (ctx.callbackQuery.data.startsWith("use:")) {
      const id = ctx.callbackQuery.data.slice("use:".length);
      const result = selectProject(id, ctx.chat?.id ?? 0, { registry, ledger, usage });
      await ctx.answerCallbackQuery("switched");
      try {
        await ctx.editMessageText(
          result.text,
          result.select?.length ? { reply_markup: projectKeyboard(result.select) } : undefined,
        );
      } catch {
        // "message is not modified" when re-tapping the active project — ignore
      }
      return;
    }

    const [kind, token] = ctx.callbackQuery.data.split(":");
    const resolve = token ? pending.get(token) : undefined;
    if (resolve) {
      pending.delete(token);
      resolve(kind === "a" ? "allow" : "deny");
      await ctx.answerCallbackQuery(kind === "a" ? "Allowed" : "Denied");
      await ctx.editMessageReplyMarkup(); // drop the buttons
    } else {
      await ctx.answerCallbackQuery();
    }
  });

  void bot.start();
  return bot;
}

/** One button per open project; the active one is starred. Tapping fires a `use:<id>` callback. */
function projectKeyboard(select: SelectableProject[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of select) kb.text(p.active ? `★ ${p.label}` : p.label, `use:${p.id}`).row();
  return kb;
}
