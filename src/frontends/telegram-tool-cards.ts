// The Telegram card of a long-running tool call (ADR-0058, amended 2026-10-30): when the call ends —
// by itself, by Stop or by Background — the card leaves the chat. Delete first; when Telegram refuses
// the delete (a message older than 48 h, no rights), drop its buttons instead. A 429 is never answered
// with the fallback edit (the flood gate holds that chat): the card waits for retry_after and is tried
// again by the sweep. A tap on a card whose call has ended removes it quietly, with no error toast.
import { GrammyError, type Api } from "grammy";
import type { Registry } from "../engine/registry";
import type { ToolCard, ToolControlCfg, ToolControlResult, ToolNotices } from "../engine/tool-control";

export type CardApi = Pick<Api, "deleteMessage" | "editMessageReplyMarkup">;

export type CardRemoval = { status: "deleted" | "stripped" | "gone" } | { status: "retry"; afterMs: number } | { status: "failed"; reason: string };

const tg = (e: unknown): GrammyError | undefined => (e instanceof GrammyError ? e : undefined);
const isGone = (e: GrammyError) => e.error_code === 400 && /message to (delete|edit) not found|MESSAGE_ID_INVALID/i.test(e.description);
const notModified = (e: GrammyError) => e.error_code === 400 && /message is not modified/i.test(e.description);
/** A 429 (from Telegram, or the flood gate's hold), a Telegram 5xx or a network error: try again later
 *  (`afterMs` 0 = no hint; the caller backs off). */
const retryOf = (e: unknown): CardRemoval | undefined => {
  const g = tg(e);
  if (!g || g.error_code >= 500) return { status: "retry", afterMs: 0 };
  if (g.error_code === 429) return { status: "retry", afterMs: (g.parameters?.retry_after ?? 1) * 1000 };
  return undefined;
};

/** Delete the card; when Telegram refuses, drop its buttons. */
export async function removeToolCard(api: CardApi, card: ToolCard): Promise<CardRemoval> {
  try {
    await api.deleteMessage(card.chatId, card.messageId);
    return { status: "deleted" };
  } catch (e) {
    const retry = retryOf(e);
    if (retry) return retry;
    if (isGone(tg(e)!)) return { status: "gone" };
  }
  try {
    await api.editMessageReplyMarkup(card.chatId, card.messageId); // no reply_markup = no buttons
    return { status: "stripped" };
  } catch (e) {
    const retry = retryOf(e);
    if (retry) return retry;
    const g = tg(e)!;
    if (notModified(g)) return { status: "stripped" };
    if (isGone(g)) return { status: "gone" };
    return { status: "failed", reason: `${g.error_code} ${g.description}` };
  }
}

type CardDeps = { notices: Pick<ToolNotices, "requeue">; api: CardApi; cfg: Pick<ToolControlCfg, "cardRemoveAttempts" | "cardSweepMs">; now: () => number; log?: (line: string) => void };

const logOf = (d: { log?: (line: string) => void }) => d.log ?? ((line: string) => console.warn(line));

/** Remove one card; a retry goes back to the notice store (after retry_after, else backing off
 *  cardSweepMs × 2^attempts), a failure is logged. */
async function settleCard(card: Parameters<ToolNotices["requeue"]>[0], d: CardDeps): Promise<void> {
  const r = await removeToolCard(d.api, card);
  if (r.status === "retry") {
    const attempts = ("attempts" in card ? card.attempts : 0) + 1;
    const wait = r.afterMs > 0 ? r.afterMs : d.cfg.cardSweepMs * 2 ** attempts;
    if (!d.notices.requeue(card, d.now() + wait, d.cfg.cardRemoveAttempts)) logOf(d)(`[telegram] tool card ${card.chatId}/${card.messageId} not removed after ${d.cfg.cardRemoveAttempts} tries`);
  } else if (r.status === "failed") {
    logOf(d)(`[telegram] tool card ${card.chatId}/${card.messageId} not removed: ${r.reason}`);
  }
}

/** A toast or a chat line is best-effort: its failure (a held 429, a stale query) is logged and never
 *  stops the card's removal. */
async function bestEffort(what: string, p: () => Promise<unknown>, d: { log?: (line: string) => void }): Promise<void> {
  try {
    await p();
  } catch (e) {
    logOf(d)(`[telegram] tool card ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The sweep (daemon timer + heartbeat): remove the cards of calls that ended since the last look. */
export async function sweepToolCards(d: CardDeps & { notices: Pick<ToolNotices, "sweep" | "takeEnded" | "requeue">; registry: Pick<Registry, "list" | "getControl"> }): Promise<void> {
  d.notices.sweep(d.registry);
  for (const card of d.notices.takeEnded(d.now())) await settleCard(card, d);
}

export interface ToolCardTapDeps extends CardDeps {
  notices: Pick<ToolNotices, "resolve" | "retire" | "requeue">;
  /** The tapped card (the message the buttons are on). */
  card: ToolCard;
  control: (target: { sessionId: string; toolUseId: string }, action: "stop" | "background") => Promise<ToolControlResult>;
  /** Answer the tap (a toast; no text = a silent answer). */
  ack: (text?: string) => Promise<void>;
  /** A line in the chat, only when it tells the operator something the toast cannot. */
  reply: (text: string) => Promise<unknown>;
  /** Swap the card's buttons for Confirm stop / Background. */
  confirmStop: () => Promise<void>;
}

/** A tap on a card's Stop (asks to confirm), Confirm stop or Background button. */
export async function handleToolCardTap(tap: { step: "stop" | "confirmStop" | "background"; key: number }, d: ToolCardTapDeps): Promise<void> {
  const target = d.notices.resolve(tap.key);
  if (!target) {
    // The call has ended (or the key is from before a restart): the card is stale — remove it quietly.
    await bestEffort("answer", () => d.ack(), d);
    await settleCard(d.card, d);
    return;
  }
  if (tap.step === "stop") {
    await bestEffort("answer", () => d.ack("tap Confirm stop to stop only this command"), d);
    await d.confirmStop().catch(() => {}); // the card was already edited
    return;
  }
  const r = await d.control(target, tap.step === "background" ? "background" : "stop");
  if (!r.ok && r.outcome === "refused") {
    // Not confirmed: the card stays while the call still shows as running (the sweep removes it once it
    // does not); say why.
    await bestEffort("answer", () => d.ack("not done"), d);
    await bestEffort("reply", () => d.reply(r.text), d);
    return;
  }
  d.notices.retire(tap.key);
  // The toast first (Telegram wants the tap answered at once), then the card, then any line.
  await bestEffort("answer", () => (r.ok ? d.ack(r.outcome === "stopped" ? "stopped" : "moved to the background") : d.ack()), d);
  await settleCard(d.card, d);
  if (r.ok && ((r.outcome === "backgrounded" && r.log) || r.extras?.length)) await bestEffort("reply", () => d.reply(r.text), d);
}

/** Post one card per call that has run past `noticeAfterMs`, remember each, then remove the cards of
 *  calls that ended (the heartbeat's tick). A Codex call gets no Background button (no SDK support). */
export async function postToolNotices(
  d: Omit<CardDeps, "notices"> & {
    notices: ToolNotices;
    registry: Pick<Registry, "list" | "getControl">;
    api: CardApi & Pick<Api, "sendMessage">;
    target: number;
    cfg: Pick<ToolControlCfg, "noticeAfterMs" | "cardRemoveAttempts" | "cardSweepMs">;
    report: (e: unknown, sessionId: string) => void;
  },
): Promise<void> {
  for (const n of d.notices.due(d.registry, d.now(), d.cfg.noticeAfterMs)) {
    const mins = Math.round((d.now() - n.call.since) / 60_000);
    const buttons = [{ text: "⏹ Stop", callback_data: `tc:s:${n.key}` }, ...(n.provider === "claude" ? [{ text: "⏩ Background", callback_data: `tc:b:${n.key}` }] : [])];
    try {
      const sent = await d.api.sendMessage(d.target, `⏵ ${n.name} has run ${n.call.tool} for ${mins}m: ${n.call.summary}\nStop ends only this command (the session goes on); Background keeps it running with a log.`, { reply_markup: { inline_keyboard: [buttons] } });
      d.notices.attach(n.key, { chatId: d.target, messageId: sent.message_id });
    } catch (e) {
      d.report(e, n.sessionId);
    }
  }
  await sweepToolCards(d);
}

/** At shutdown: remove every card still in the chat. The next boot's keys never match them, so their
 *  buttons could only answer "ended". One try each, no retry (the process is exiting). */
export async function clearToolCards(d: { notices: Pick<ToolNotices, "takeAll">; api: CardApi; log?: (line: string) => void }): Promise<void> {
  await Promise.all(
    d.notices.takeAll().map(async (card) => {
      const r = await removeToolCard(d.api, card);
      if (r.status === "retry" || r.status === "failed") logOf(d)(`[telegram] tool card ${card.chatId}/${card.messageId} left at shutdown (${r.status})`);
    }),
  );
}
