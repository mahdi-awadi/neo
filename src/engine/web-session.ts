// Signed operator session tokens for the web console. After a valid Telegram login
// (telegram-auth) the server mints a token = `userId.expiry.hmac`, set as a cookie; every
// later request is authorized by verifying it. Stateless (HMAC-signed), so no session db.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionStore {
  /** Mint a signed token for `userId`, valid for `ttlSec`. */
  issue(userId: number, now?: number): string;
  /** Return the userId if the token is authentic and unexpired, else undefined. */
  verify(token: string, now?: number): number | undefined;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function createSessionStore(opts: { secret: string; ttlSec?: number }): SessionStore {
  const ttlSec = opts.ttlSec ?? 7 * 24 * 3600; // 1 week

  return {
    issue(userId, now = nowSec()) {
      const payload = `${userId}.${now + ttlSec}`;
      return `${payload}.${sign(payload, opts.secret)}`;
    },
    verify(token, now = nowSec()) {
      if (typeof token !== "string") return undefined;
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;
      const [uid, exp, sig] = parts;
      const payload = `${uid}.${exp}`;
      if (!safeEqualHex(sign(payload, opts.secret), sig)) return undefined;
      const expiry = Number(exp);
      const userId = Number(uid);
      if (!Number.isFinite(expiry) || !Number.isFinite(userId) || now >= expiry) return undefined;
      return userId;
    },
  };
}
