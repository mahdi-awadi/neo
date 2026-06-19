// Verify a Telegram Login Widget payload (https://core.telegram.org/widgets/login).
// This is the security gate for the web operator console: only someone who actually
// authenticated with Neo's bot (and whose id is the enrolled admin) gets a session.
//
// Algorithm (Login Widget — NOT the WebApp initData variant):
//   data_check_string = every received field except `hash`, as `key=value`, sorted by key,
//                       joined with "\n".
//   secret_key        = SHA256(bot_token)                    (raw bytes)
//   computed          = HMAC_SHA256(data_check_string, secret_key) as hex
//   valid             = timing-safe-equal(computed, hash) AND auth_date is fresh.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Raw Login Widget payload — fields arrive as untyped query/form params. */
export type TelegramLoginData = Record<string, unknown>;

export interface TelegramLoginResult {
  ok: boolean;
  userId?: number;
  reason?: string;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function verifyTelegramLogin(
  data: TelegramLoginData,
  botToken: string,
  opts: { maxAgeSec?: number; now?: number } = {},
): TelegramLoginResult {
  const hash = data.hash;
  if (typeof hash !== "string" || hash.length === 0) return { ok: false, reason: "missing hash" };

  const dataCheckString = Object.keys(data)
    .filter((k) => k !== "hash" && data[k] !== undefined && data[k] !== null)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join("\n");

  const secretKey = createHash("sha256").update(botToken).digest();
  const computed = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!safeEqualHex(computed, hash)) return { ok: false, reason: "bad hash" };

  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate)) return { ok: false, reason: "bad auth_date" };
  const maxAgeSec = opts.maxAgeSec ?? 86400; // 1 day
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (now - authDate > maxAgeSec) return { ok: false, reason: "expired" };

  return { ok: true, userId: Number(data.id) };
}
