// ADR-0058 amendment (2026-10-30): a long-running tool call's Telegram card leaves the chat when the
// call ends — by itself, by Stop or by Background — and a tap on a stale card removes it quietly.
import { test, expect } from "bun:test";
import { GrammyError } from "grammy";
import { removeToolCard, sweepToolCards, handleToolCardTap, postToolNotices, clearToolCards, type CardApi } from "../src/frontends/telegram-tool-cards";
import { createToolNotices, type ToolControlResult } from "../src/engine/tool-control";
import { createRegistry } from "../src/engine/registry";

const tgErr = (method: string, error_code: number, description: string, retry_after?: number) =>
  new GrammyError(`Call to '${method}' failed!`, { ok: false, error_code, description, ...(retry_after ? { parameters: { retry_after } } : {}) }, method, {});

/** A fake Bot API: each method answers from its script (an error to throw, else success). */
function fakeApi(script: { deleteMessage?: (Error | undefined)[]; editMessageReplyMarkup?: (Error | undefined)[] } = {}) {
  const calls: string[] = [];
  const next = (m: "deleteMessage" | "editMessageReplyMarkup") => {
    const e = script[m]?.shift();
    if (e) throw e;
    return true as const;
  };
  const api: CardApi = {
    deleteMessage: (async (chat: number, msg: number) => (calls.push(`delete ${chat}/${msg}`), next("deleteMessage"))) as never,
    editMessageReplyMarkup: (async (chat: number, msg: number, other?: unknown) => (calls.push(`strip ${chat}/${msg}${other ? " +markup" : ""}`), next("editMessageReplyMarkup"))) as never,
  };
  return { api, calls };
}
const card = { chatId: 42, messageId: 7 };

test("removeToolCard deletes the card", async () => {
  const f = fakeApi();
  expect(await removeToolCard(f.api, card)).toEqual({ status: "deleted" });
  expect(f.calls).toEqual(["delete 42/7"]);
});

test("removeToolCard falls back to dropping the buttons when Telegram refuses the delete (older than 48 h)", async () => {
  const f = fakeApi({ deleteMessage: [tgErr("deleteMessage", 400, "Bad Request: message can't be deleted for everyone")] });
  expect(await removeToolCard(f.api, card)).toEqual({ status: "stripped" });
  expect(f.calls).toEqual(["delete 42/7", "strip 42/7"]); // no markup = no buttons
});

test("removeToolCard: a card already gone is done; a fallback whose buttons are already gone is done", async () => {
  expect(await removeToolCard(fakeApi({ deleteMessage: [tgErr("deleteMessage", 400, "Bad Request: message to delete not found")] }).api, card)).toEqual({ status: "gone" });
  const f = fakeApi({ deleteMessage: [tgErr("deleteMessage", 400, "Bad Request: message can't be deleted")], editMessageReplyMarkup: [tgErr("editMessageReplyMarkup", 400, "Bad Request: message is not modified")] });
  expect(await removeToolCard(f.api, card)).toEqual({ status: "stripped" });
});

test("removeToolCard: a 429 (or the flood gate's hold) is retried after retry_after, never answered by the fallback edit", async () => {
  const f = fakeApi({ deleteMessage: [tgErr("deleteMessage", 429, "Too Many Requests: retry after 30", 30)] });
  expect(await removeToolCard(f.api, card)).toEqual({ status: "retry", afterMs: 30_000 });
  expect(f.calls).toEqual(["delete 42/7"]);
  const net = fakeApi({ deleteMessage: [new Error("socket hang up")] });
  expect(await removeToolCard(net.api, card)).toEqual({ status: "retry", afterMs: 0 });
});

test("removeToolCard: both the delete and the fallback refused → failed, with Telegram's reason", async () => {
  const f = fakeApi({ deleteMessage: [tgErr("deleteMessage", 403, "Forbidden: bot was blocked by the user")], editMessageReplyMarkup: [tgErr("editMessageReplyMarkup", 403, "Forbidden: bot was blocked by the user")] });
  const r = await removeToolCard(f.api, card);
  expect(r.status).toBe("failed");
  expect(r.status === "failed" && r.reason).toContain("blocked");
});

test("sweepToolCards removes the cards of calls that ended, retries a 429 later, and drops a card after its attempts", async () => {
  const registry = createRegistry();
  const s = registry.add({ id: "s1", source: "neo", folder: "/home/eticket-v3", task: "t", chatId: 1, createdAt: 0 }, 0);
  let running = [{ toolUseId: "toolu_A", tool: "Bash", summary: "a", since: 0 }];
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, tools: { provider: "claude", running: () => running, background: async () => ({ ok: true }), stop: async () => ({ ok: true }) } } as never);
  const notices = createToolNotices();
  const [d] = notices.due(registry, 200_000, 120_000);
  notices.attach(d!.key, card);
  const cfg = { cardRemoveAttempts: 2, cardSweepMs: 1_000 };
  const f = fakeApi({ deleteMessage: [tgErr("deleteMessage", 429, "Too Many Requests: retry after 5", 5)] });
  await sweepToolCards({ notices, registry, api: f.api, cfg, now: () => 1_000 });
  expect(f.calls).toEqual([]); // still running
  running = [];
  await sweepToolCards({ notices, registry, api: f.api, cfg, now: () => 1_000 });
  expect(f.calls).toEqual(["delete 42/7"]); // 429: kept for later
  await sweepToolCards({ notices, registry, api: f.api, cfg, now: () => 5_999 });
  expect(f.calls.length).toBe(1); // not before retry_after
  await sweepToolCards({ notices, registry, api: f.api, cfg, now: () => 6_000 });
  expect(f.calls).toEqual(["delete 42/7", "delete 42/7"]); // deleted on the second try
  await sweepToolCards({ notices, registry, api: f.api, cfg, now: () => 99_000 });
  expect(f.calls.length).toBe(2);

  notices.requeue({ chatId: 42, messageId: 9 }, 0, 2);
  const flaky = fakeApi({ deleteMessage: [new Error("reset"), new Error("reset"), new Error("reset")] });
  await sweepToolCards({ notices, registry, api: flaky.api, cfg, now: () => 0 });
  await sweepToolCards({ notices, registry, api: flaky.api, cfg, now: () => 0 });
  expect(flaky.calls.length).toBe(1); // the second failure reached cardRemoveAttempts: dropped
});

/** A tap rig: one notice with a card, a fake control seam, and what the operator sees. */
function tapRig(result?: ToolControlResult, apiScript?: Parameters<typeof fakeApi>[0]) {
  const registry = createRegistry();
  const s = registry.add({ id: "s1", source: "neo", folder: "/home/eticket-v3", task: "t", chatId: 1, createdAt: 0 }, 0);
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, tools: { provider: "claude", running: () => [{ toolUseId: "toolu_A", tool: "Bash", summary: "sleep 600", since: 0 }], background: async () => ({ ok: true }), stop: async () => ({ ok: true }) } } as never);
  const notices = createToolNotices();
  const [d] = notices.due(registry, 200_000, 120_000);
  notices.attach(d!.key, card);
  const f = fakeApi(apiScript);
  const seen: string[] = [];
  const controlled: string[] = [];
  const deps = {
    notices,
    api: f.api,
    card,
    cfg: { cardRemoveAttempts: 5, cardSweepMs: 1_000 },
    now: () => 0,
    control: async (t: { sessionId: string; toolUseId: string }, action: string) => (controlled.push(`${action} ${t.toolUseId}`), result!),
    ack: async (text?: string) => void seen.push(`toast ${text ?? "-"}`),
    reply: async (text: string) => void seen.push(`reply ${text}`),
    confirmStop: async () => void seen.push("confirm buttons"),
  };
  return { key: d!.key, deps, calls: f.calls, seen, controlled, notices };
}

test("a tap on a stale card (call ended, or a key from before a restart) removes the card quietly", async () => {
  const r = tapRig();
  await handleToolCardTap({ step: "background", key: 1 }, r.deps); // no such key
  expect(r.seen).toEqual(["toast -"]); // an empty answer: no error toast
  expect(r.calls).toEqual(["delete 42/7"]);
  expect(r.controlled).toEqual([]);
});

test("Stop's first tap asks to confirm and keeps the card", async () => {
  const r = tapRig();
  await handleToolCardTap({ step: "stop", key: r.key }, r.deps);
  expect(r.seen).toEqual(["toast tap Confirm stop to stop only this command", "confirm buttons"]);
  expect(r.calls).toEqual([]);
});

test("a confirmed Stop deletes the card; the toast says it; a plain stop sends no extra line", async () => {
  const r = tapRig({ ok: true, outcome: "stopped", toolUseId: "toolu_A", command: "sleep 600", text: "Stopped `sleep 600` in eticket-v3; the session goes on." });
  await handleToolCardTap({ step: "confirmStop", key: r.key }, r.deps);
  expect(r.controlled).toEqual(["stop toolu_A"]);
  expect(r.seen).toEqual(["toast stopped"]);
  expect(r.calls).toEqual(["delete 42/7"]);
  expect(r.notices.resolve(r.key)).toBeUndefined(); // a later tap is stale
});

test("a Stop with something to report (container processes, survivors) sends that one line", async () => {
  const text = "Stopped `x` in eticket-v3; the session goes on. (2 processes inside containers stopped too)";
  const r = tapRig({ ok: true, outcome: "stopped", toolUseId: "toolu_A", command: "x", text, extras: ["2 processes inside containers stopped too"] });
  await handleToolCardTap({ step: "confirmStop", key: r.key }, r.deps);
  expect(r.seen).toEqual(["toast stopped", `reply ${text}`]);
  expect(r.calls).toEqual(["delete 42/7"]);
});

test("Background deletes the card and sends one line with the log path", async () => {
  const text = "Moved `sleep 600` in eticket-v3 to the background; its log is /tmp/x.output. It keeps running; the worker goes on.";
  const r = tapRig({ ok: true, outcome: "backgrounded", toolUseId: "toolu_A", command: "sleep 600", log: "/tmp/x.output", text });
  await handleToolCardTap({ step: "background", key: r.key }, r.deps);
  expect(r.controlled).toEqual(["background toolu_A"]);
  expect(r.seen).toEqual(["toast moved to the background", `reply ${text}`]);
  expect(r.calls).toEqual(["delete 42/7"]);
});

test("a tap that finds the command already ended (the 'Could not move …' case) removes the card quietly", async () => {
  const r = tapRig({ ok: false, outcome: "not_running", toolUseId: "toolu_A", command: "sleep 600", text: "Could not move `sleep 600` to the background: not_running." });
  await handleToolCardTap({ step: "background", key: r.key }, r.deps);
  expect(r.seen).toEqual(["toast -"]);
  expect(r.calls).toEqual(["delete 42/7"]);
});

test("a toast or a reply line that fails (a 429 held by the flood gate) never leaves the card behind", async () => {
  const r = tapRig({ ok: true, outcome: "backgrounded", toolUseId: "toolu_A", command: "x", log: "/tmp/x.output", text: "Moved." });
  const logs: string[] = [];
  const deps = {
    ...r.deps,
    log: (l: string) => void logs.push(l),
    ack: async () => {
      throw tgErr("answerCallbackQuery", 400, "Bad Request: something");
    },
    reply: async () => {
      throw tgErr("sendMessage", 429, "Too Many Requests: retry after 600", 600);
    },
  };
  await handleToolCardTap({ step: "background", key: r.key }, deps);
  expect(r.calls).toEqual(["delete 42/7"]);
  expect(logs.length).toBe(2); // both failures are logged, not thrown
  const stale = tapRig();
  await handleToolCardTap({ step: "stop", key: 1 }, { ...stale.deps, log: () => {}, ack: async () => { throw new Error("x"); } });
  expect(stale.calls).toEqual(["delete 42/7"]);
});

test("removeToolCard: a Telegram 5xx is retried, not answered with the fallback", async () => {
  const f = fakeApi({ deleteMessage: [tgErr("deleteMessage", 502, "Bad Gateway")] });
  expect(await removeToolCard(f.api, card)).toEqual({ status: "retry", afterMs: 0 });
  expect(f.calls).toEqual(["delete 42/7"]);
});

test("a retry with no retry_after backs off: cardSweepMs × 2^attempts", async () => {
  const notices = createToolNotices();
  notices.requeue(card, 0, 9);
  const api = fakeApi({ deleteMessage: [new Error("reset"), new Error("reset")] }).api;
  const registry = createRegistry();
  const cfg = { cardRemoveAttempts: 9, cardSweepMs: 1_000 };
  await sweepToolCards({ notices, registry, api, cfg, now: () => 0 }); // attempts 1 → 2
  expect(notices.takeEnded(3_999)).toEqual([]);
  expect(notices.takeEnded(4_000)).toEqual([{ chatId: 42, messageId: 7, attempts: 2, notBefore: 4_000 }]);
});

test("postToolNotices posts one card per due call and remembers it, so the card goes when the call ends", async () => {
  const registry = createRegistry();
  const s = registry.add({ id: "s1", source: "neo", folder: "/home/eticket-v3", task: "t", chatId: 1, createdAt: 0 }, 0);
  let running = [{ toolUseId: "toolu_A", tool: "Bash", summary: "git push origin dev", since: 0 }];
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, tools: { provider: "codex", running: () => running, background: async () => ({ ok: true }), stop: async () => ({ ok: true }) } } as never);
  const notices = createToolNotices();
  const f = fakeApi();
  const sent: { chat: number; text: string; buttons: string[] }[] = [];
  const api = {
    ...f.api,
    sendMessage: (async (chat: number, text: string, other: { reply_markup: { inline_keyboard: { text: string }[][] } }) => {
      sent.push({ chat, text, buttons: other.reply_markup.inline_keyboard[0]!.map((b) => b.text) });
      return { message_id: 77 };
    }) as never,
  };
  const deps = { notices, registry, api, target: 42, cfg: { noticeAfterMs: 120_000, cardRemoveAttempts: 5, cardSweepMs: 5_000 }, now: () => 180_000, report: () => {} };
  await postToolNotices(deps);
  expect(sent).toEqual([{ chat: 42, text: expect.stringContaining("eticket-v3 has run Bash for 3m: git push origin dev"), buttons: ["⏹ Stop"] }]); // Codex: no Background
  running = [];
  await postToolNotices(deps);
  expect(f.calls).toEqual(["delete 42/77"]);
});

test("at shutdown every remaining card is removed (the next boot cannot act on it)", async () => {
  const registry = createRegistry();
  const s = registry.add({ id: "s1", source: "neo", folder: "/home/eticket-v3", task: "t", chatId: 1, createdAt: 0 }, 0);
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, tools: { provider: "claude", running: () => [{ toolUseId: "toolu_A", tool: "Bash", summary: "a", since: 0 }], background: async () => ({ ok: true }), stop: async () => ({ ok: true }) } } as never);
  const notices = createToolNotices();
  const [d] = notices.due(registry, 200_000, 120_000);
  notices.attach(d!.key, card);
  notices.requeue({ chatId: 42, messageId: 8 }, 1e12, 5); // a retry far in the future
  const f = fakeApi();
  await clearToolCards({ notices, api: f.api });
  expect(f.calls.sort()).toEqual(["delete 42/7", "delete 42/8"]);
  expect(notices.resolve(d!.key)).toBeUndefined();
});

test("a refused Stop keeps the card while the call still shows as running, and says why", async () => {
  const text = "Could not confirm the stop of `x` in eticket-v3 (timeout); it may still be running in the background — check /list.";
  const r = tapRig({ ok: false, outcome: "refused", toolUseId: "toolu_A", command: "x", text });
  await handleToolCardTap({ step: "confirmStop", key: r.key }, r.deps);
  expect(r.seen).toEqual(["toast not done", `reply ${text}`]);
  expect(r.calls).toEqual([]);
  expect(r.notices.resolve(r.key)).toBeDefined();
});

test("a tap whose delete is rate-limited hands the card to the sweep instead of dropping it", async () => {
  const r = tapRig({ ok: true, outcome: "stopped", toolUseId: "toolu_A", command: "x", text: "Stopped." }, { deleteMessage: [tgErr("deleteMessage", 429, "Too Many Requests: retry after 3", 3)] });
  await handleToolCardTap({ step: "confirmStop", key: r.key }, r.deps);
  expect(r.notices.takeEnded(2_999)).toEqual([]);
  expect(r.notices.takeEnded(3_000)).toEqual([{ chatId: 42, messageId: 7, attempts: 1, notBefore: 3_000 }]);
});
