// Telegram flood control — the one gate every outbound Bot API send passes through.
//
// Why: Telegram answers a chat that receives too many messages with 429 + `retry_after`. Neo used
// to swallow that error silently and keep sending, which turned a short limit into a ~9h ban
// (2026-10-01) with nothing in the log and the ledger showing every reply as "sent".
//
// The rule: a short 429 (retry_after ≤ maxWaitMs) waits and retries once. A long 429 blocks that
// chat until retry_after passes: later sends to it are held (not sent, so the ban is not extended),
// the block is logged once, and when it lifts `onRecovered` reports how many messages were lost.
// Every other failed send is logged. Non-send methods (getUpdates, getMe, …) are never gated.

/** The Bot API response shape the gate reads (grammY's ApiResponse, minus the result payload). */
export interface ApiResult {
  ok: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface FloodGateOpts {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Longest 429 wait handled by sleeping and retrying; longer ones block the chat. */
  maxWaitMs: number;
  /** Called once when a blocked chat sends again, with how many messages were not delivered. */
  onRecovered?: (chatId: number | string, dropped: number) => void;
}

export interface FloodGate {
  run<R extends ApiResult>(method: string, chatId: number | string | undefined, call: () => Promise<R>): Promise<R>;
}

const GATED_METHOD = /^(send|edit|copy|forward)/;

export function createFloodGate(opts: FloodGateOpts): FloodGate {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.error(line));
  const blocks = new Map<string, { until: number; dropped: number }>();

  const retryMs = (r: ApiResult) => (r.parameters?.retry_after ?? 0) * 1000;

  return {
    async run(method, chatId, call) {
      if (!GATED_METHOD.test(method)) return call();
      const key = String(chatId ?? "global");

      const block = blocks.get(key);
      if (block && now() < block.until) {
        block.dropped++;
        const held: ApiResult = {
          ok: false,
          error_code: 429,
          description: "held by Neo's flood gate (Telegram rate limit in force)",
          parameters: { retry_after: Math.ceil((block.until - now()) / 1000) },
        };
        return held as Awaited<ReturnType<typeof call>>;
      }
      if (block) {
        blocks.delete(key);
        log(`[telegram] rate limit on chat ${key} lifted — ${block.dropped} message(s) were not delivered`);
        opts.onRecovered?.(chatId ?? key, block.dropped);
      }

      let result = await call();
      if (!result.ok && result.error_code === 429 && retryMs(result) <= opts.maxWaitMs) {
        log(`[telegram] ${method} to chat ${key}: 429, waiting ${retryMs(result)}ms then retrying once`);
        await sleep(retryMs(result));
        result = await call();
      }
      if (result.ok) return result;

      if (result.error_code === 429) {
        const ms = Math.max(retryMs(result), 1000);
        blocks.set(key, { until: now() + ms, dropped: 1 });
        log(
          `[telegram] ${method} to chat ${key}: 429 rate limited, retry_after ${result.parameters?.retry_after ?? "?"}s — ` +
            `holding sends to this chat until ${new Date(now() + ms).toISOString()}`,
        );
      } else {
        log(`[telegram] ${method} to chat ${key} failed: ${result.error_code ?? "?"} ${result.description ?? ""}`.trimEnd());
      }
      return result;
    },
  };
}

/** True for the per-tool stream lines a worker emits (session-runner's "🔧 Tool: …" milestones and
 *  "↳ …" result previews, plus the governor's "🔓 auto-approved: …" notes). They are ~86% of
 *  outbound volume, so Telegram skips them by default (`telegramToolSteps`); the ledger and the web
 *  console still get every line. */
export function isToolStepLine(text: string): boolean {
  return /^(🔧 |↳ |⚠️ ↳ |🔓 auto-approved: )/u.test(text);
}
