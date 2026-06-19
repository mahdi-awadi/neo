import { test, expect } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { verifyTelegramLogin } from "../src/engine/telegram-auth";

const TOKEN = "123456:TESTTOKEN";

// Independent oracle: sign a Login Widget payload exactly per Telegram's spec
// (data-check-string of sorted k=v, key = SHA256(bot_token)).
function signLogin(data: Record<string, string | number>, token: string): string {
  const dcs = Object.keys(data)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join("\n");
  const secret = createHash("sha256").update(token).digest();
  return createHmac("sha256", secret).update(dcs).digest("hex");
}

test("accepts a correctly-signed, fresh login payload", () => {
  const data: Record<string, string | number> = { id: 555, first_name: "Neo", username: "neo", auth_date: 1000 };
  data.hash = signLogin(data, TOKEN);
  const r = verifyTelegramLogin(data, TOKEN, { now: 1000 });
  expect(r.ok).toBe(true);
  expect(r.userId).toBe(555);
});

test("rejects a tampered payload (hash mismatch)", () => {
  const data: Record<string, string | number> = { id: 555, first_name: "Neo", auth_date: 1000 };
  data.hash = signLogin(data, TOKEN);
  data.first_name = "Mallory"; // tamper after signing
  expect(verifyTelegramLogin(data, TOKEN, { now: 1000 }).ok).toBe(false);
});

test("rejects a stale auth_date beyond maxAgeSec", () => {
  const data: Record<string, string | number> = { id: 555, auth_date: 1000 };
  data.hash = signLogin(data, TOKEN);
  const r = verifyTelegramLogin(data, TOKEN, { now: 1000 + 86401 });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("expired");
});

test("rejects a payload signed with a different bot token", () => {
  const data: Record<string, string | number> = { id: 555, auth_date: 1000 };
  data.hash = signLogin(data, "999:OTHER");
  expect(verifyTelegramLogin(data, TOKEN, { now: 1000 }).ok).toBe(false);
});

test("rejects when the hash is missing", () => {
  expect(verifyTelegramLogin({ id: 1, auth_date: 1000 }, TOKEN, { now: 1000 }).ok).toBe(false);
});
