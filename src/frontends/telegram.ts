// The channel you talk to projects through. Thin grammy glue over the engine pipeline:
// it translates Telegram updates into handleOrder() calls and renders escalations as
// Allow/Deny inline buttons. All the logic lives in engine/pipeline.ts (tested); this
// file is I/O wiring, verified at the daemon e2e step.
import { Bot, InlineKeyboard } from "grammy";
import type { NeoConfig } from "../config";
import type { Ledger } from "../engine/ledger";
import { handleOrder } from "../engine/pipeline";

export function startTelegram(cfg: NeoConfig, ledger: Ledger): Bot {
  const bot = new Bot(cfg.telegramToken);
  const allow = new Set(cfg.telegramAllowFrom);
  // Pending approvals keyed by a per-request token: callback press -> resolver.
  const pending = new Map<string, (decision: "allow" | "deny") => void>();

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined || (allow.size > 0 && !allow.has(userId))) return;
    const chatId = ctx.chat.id;

    await handleOrder(ctx.message.text, chatId, {
      cfg,
      ledger,
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
