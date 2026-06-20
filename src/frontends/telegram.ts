// The channel you talk to projects through. Thin grammy glue over the engine pipeline:
// it translates Telegram updates into handleOrder() calls and renders escalations as
// Allow/Deny inline buttons. All the logic lives in engine/pipeline.ts (tested); this
// file is I/O wiring, verified at the daemon e2e step.
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { basename } from "node:path";
import { saveInbound } from "../engine/files";
import type { NeoConfig } from "../config";
import type { Ledger } from "../engine/ledger";
import type { Registry } from "../engine/registry";
import type { Meter } from "../engine/budget";
import type { AdminStore } from "../engine/admin";
import type { UsageMeter } from "../engine/usage";
import type { TrustStore } from "../engine/trust";
import { createRegistry } from "../engine/registry";
import { createMeter } from "../engine/budget";
import { openTrustStore } from "../engine/trust";
import { handleMessage } from "../engine/pipeline";
import { handleCommand, selectProject, killProject, type SelectableProject } from "../engine/commands";
import { handleLoop, listLoops, matchLoop, startLoop } from "../engine/loops";
import { mdToHtml } from "../engine/format";

async function downloadTelegramFile(token: string, filePath: string): Promise<Uint8Array> {
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Send worker output as formatted HTML (bold/code/bullets), falling back to plain text if
 *  Telegram rejects the markup. `project` tags which project the line came from. */
async function sendFormatted(bot: Bot, chatId: number, text: string, project?: string): Promise<void> {
  const tag = project ? `<b>[${project.replace(/[&<>]/g, "")}]</b> ` : "";
  try {
    await bot.api.sendMessage(chatId, tag + mdToHtml(text, { tables: "pre" }), { parse_mode: "HTML" });
  } catch {
    try {
      await bot.api.sendMessage(chatId, (project ? `[${project}] ` : "") + text);
    } catch {
      // give up silently — a dropped progress line shouldn't crash the bot
    }
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
): Bot {
  const bot = new Bot(cfg.telegramToken);
  const allow = new Set(cfg.telegramAllowFrom);
  // Pending approvals keyed by a per-request token: callback press -> resolver.
  const pending = new Map<string, (decision: "allow" | "deny") => void>();

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
    reply: (cid, text, project) => void sendFormatted(bot, cid, text, project),
    askApproval: (cid, reason) =>
      new Promise<"allow" | "deny">((resolve) => {
        const token = crypto.randomUUID();
        pending.set(token, resolve);
        const kb = new InlineKeyboard().text("Allow", `a:${token}`).text("Deny", `d:${token}`);
        void bot.api.sendMessage(cid, `⚠️ Approve this action?\n${reason}`, { reply_markup: kb });
      }),
    sendFile: (cid, path, caption) =>
      void bot.api.sendDocument(cid, new InputFile(path), caption ? { caption } : {}),
  });

  // Receive a document or photo from the operator: save to the active project's inbox,
  // then feed an augmented message to the pipeline so the worker knows the file arrived.
  async function intakeFile(ctx: any, name: string, captionText: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!isOperator(userId)) return;
    const chatId = ctx.chat.id;
    const target = registry.findByChat(chatId) ?? registry.getDefault();
    if (!target) {
      void bot.api.sendMessage(chatId, "No active project to receive the file.");
      return;
    }
    const file = await ctx.getFile();
    const bytes = await downloadTelegramFile(cfg.telegramToken, file.file_path!);
    const path = saveInbound(target.order.folder, name, bytes);
    await handleMessage(
      `📎 operator attached \`${name}\` at \`${path}\`\n${captionText}`,
      chatId,
      pipelineDeps(),
    );
  }

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isOperator(userId)) return;
    const chatId = ctx.chat.id;

    // Bare /loop → tappable run buttons; /loop <name> starts a background loop (streams progress).
    if (ctx.message.text.trim() === "/loop") {
      const kb = new InlineKeyboard();
      for (const l of listLoops()) kb.text(`▶ ${l.usage.replace("/loop ", "")}`, `runloop:${l.name}`).row();
      void bot.api.sendMessage(chatId, "Run a loop:", { reply_markup: kb });
      return;
    }
    if (handleLoop(ctx.message.text, chatId, { reply: (cid, t) => void bot.api.sendMessage(cid, t) })) return;

    // Engine commands (/list, /kill, /help, …) resolve synchronously; everything else is an
    // order or a follow-up handled by the pipeline.
    const command = handleCommand(ctx.message.text, chatId, { registry, ledger, usage, trust });
    if (command !== null) {
      if (command.select?.length) {
        void bot.api.sendMessage(chatId, command.text, { reply_markup: projectKeyboard(command.select) });
      } else {
        void bot.api.sendMessage(chatId, command.text);
      }
      return;
    }

    await handleMessage(ctx.message.text, chatId, pipelineDeps());
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
        ? selectProject(id, chatId, { registry, ledger, usage, trust })
        : killProject(id, chatId, { registry, ledger, usage, trust });
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

    // Tap a loop run button.
    if (cb.startsWith("runloop:")) {
      const loop = matchLoop(cb.slice("runloop:".length));
      await ctx.answerCallbackQuery(loop ? "running" : "unknown loop");
      if (loop) void startLoop(loop, ctx.chat?.id ?? 0, { reply: (cid, t) => void bot.api.sendMessage(cid, t) });
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
  for (const p of select) kb.text(p.active ? `★ ${p.label}` : p.label, `use:${p.id}`).text("✕", `kill:${p.id}`).row();
  return kb;
}
