// Reliable delivery to Telegram (2026-07-25 issue 3). Worker output used to be fire-and-forget:
// every streamed line was an un-awaited sendMessage racing the others into one chat, so lines
// arrived out of order, and a flood-control 429 dropped them silently. Three pieces fix that:
//   • createChatQueue — per-chat FIFO, so lines land in the order the worker produced them;
//   • telegramRetryTransformer — a grammY API transformer that waits out 429 `retry_after` and
//     retries network failures with backoff, for every Bot API call;
//   • sendOperatorLine — the raw-fetch path the loop scheduler uses, with the same guarantees.
// A line that still can't be delivered is logged with its text, never dropped in silence.
import { HttpError, type Transformer } from "grammy";
import { mdToHtml, projectHashtag } from "../engine/format";

/** Prefix for every project-attributed outbound line: a clickable Telegram hashtag
 *  (#waselni, #eticket_v3, ...) so tapping it filters the chat to that project. Kept as plain
 *  text — never wrapped in <code>/<pre> — so Telegram auto-links it under parse_mode HTML too. */
export function projectTagPrefix(project?: string): string {
  return project ? `${projectHashtag(project)} ` : "";
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retries for one Bot API call before it fails (flood control and network errors alike). */
export const TELEGRAM_MAX_RETRIES = 5;
/** Backoff for network failures (no retry_after to go by): 1s, 2s, 4s, … capped. */
const NETWORK_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

export interface ChatQueue {
  /** Run `task` after every earlier task for the same chat has settled. Resolves/rejects with it. */
  run<T>(chatId: number, task: () => Promise<T>): Promise<T>;
}

export function createChatQueue(): ChatQueue {
  const tails = new Map<number, Promise<unknown>>();
  return {
    run(chatId, task) {
      const prev = tails.get(chatId) ?? Promise.resolve();
      const next = prev.then(task, task); // a failed send must not stall the chat's queue
      const tail = next.catch(() => {});
      tails.set(chatId, tail);
      void tail.then(() => {
        if (tails.get(chatId) === tail) tails.delete(chatId); // nothing queued behind it
      });
      return next;
    },
  };
}

type Wait = (ms: number) => Promise<void>;

/** grammY transformer: honour 429 retry_after and retry network failures, for every API call. */
export function telegramRetryTransformer(opts: { sleep?: Wait; maxRetries?: number } = {}): Transformer {
  const sleep = opts.sleep ?? realSleep;
  const maxRetries = opts.maxRetries ?? TELEGRAM_MAX_RETRIES;
  return (async (prev, method, payload, signal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await prev(method, payload, signal);
        const retryAfter = (res as { parameters?: { retry_after?: number } }).parameters?.retry_after;
        if (!res.ok && res.error_code === 429 && attempt < maxRetries) {
          await sleep((retryAfter ?? 1) * 1000);
          continue;
        }
        return res;
      } catch (err) {
        if (!(err instanceof HttpError) || attempt >= maxRetries) throw err;
        await sleep(NETWORK_BACKOFF_MS[Math.min(attempt, NETWORK_BACKOFF_MS.length - 1)]!);
      }
    }
  }) as Transformer;
}

/** Log a line that could not be delivered, with enough of its text to diagnose from logs alone. */
export function logDropped(log: (m: string) => void, chatId: number, text: string, err?: unknown): void {
  const why = err instanceof Error ? err.message : err === undefined ? "" : String(err);
  log(`[telegram] could not deliver to chat ${chatId}${why ? ` (${why})` : ""}: ${text.slice(0, 500)}`);
}

// Loop-scheduler lines share one queue so they too arrive in order.
const operatorLineQueue = createChatQueue();

/** Post a single line to the operator's chat over the raw Bot API (no grammy Bot instance needed),
 *  project-tagged + HTML-formatted with a plain-text fallback — the same #project style as streamed
 *  worker/dispatch output. Used by the daemon's loop scheduler so scheduled-loop worker output
 *  reaches the operator's Telegram channel, not just daemon stdout. Waits out 429s, retries network
 *  failures, and logs (never throws) a line it finally can't deliver. */
export function sendOperatorLine(
  token: string,
  chatId: number,
  text: string,
  project?: string,
  io: { fetch?: typeof fetch; sleep?: Wait; log?: (m: string) => void } = {},
): Promise<void> {
  const doFetch = io.fetch ?? fetch;
  const sleep = io.sleep ?? realSleep;
  const log = io.log ?? ((m: string) => console.error(m));
  const tag = projectTagPrefix(project);
  const post = async (body: string, html: boolean): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: body, ...(html ? { parse_mode: "HTML" } : {}) }),
        });
        if (r.status === 429 && attempt < TELEGRAM_MAX_RETRIES) {
          const j = (await r.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
          await sleep((j.parameters?.retry_after ?? 1) * 1000);
          continue;
        }
        return r;
      } catch (err) {
        if (attempt >= TELEGRAM_MAX_RETRIES) throw err;
        await sleep(NETWORK_BACKOFF_MS[Math.min(attempt, NETWORK_BACKOFF_MS.length - 1)]!);
      }
    }
  };
  return operatorLineQueue.run(chatId, async () => {
    try {
      const r = await post(tag + mdToHtml(text, { tables: "pre" }), true);
      if (r.ok) return;
      const plain = await post(tag + text, false); // Telegram rejected the markup — resend as plain text
      if (!plain.ok) logDropped(log, chatId, text, `HTTP ${plain.status}`);
    } catch (err) {
      logDropped(log, chatId, text, err); // a dropped loop line must never crash the daemon
    }
  });
}
