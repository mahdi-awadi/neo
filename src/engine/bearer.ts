// Machine-to-machine bearer checks (reach plan P0.5, gap G8): compared in constant time, so a wrong
// token's timing says nothing about the secret. Both sides are hashed first, so the compare is always
// over equal-length buffers and the secret's length does not leak either.
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** True only when `header` is exactly `Bearer <secret>`; an empty secret never passes. */
export function bearerOk(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

/** The secret that guards POST /inbox: its own `INBOX_INGEST_SECRET` when set, else the agent-ingress
 *  one (as before), so a deployment changes nothing until it sets the new secret. */
export function inboxSecretOf(cfg: { agentIngressSecret: string; inboxIngestSecret?: string }): string {
  return cfg.inboxIngestSecret || cfg.agentIngressSecret;
}
