// Resolve where an operator's REPLY should go. Replaces the old fire-and-forget routeByReply that
// silently no-op'd on a lookup miss — which let a reply meant for a project fall through to the
// company/default and act against the wrong project. Deterministic + AI-free; unit-tested against a
// real registry + ledger, so the Telegram frontend stays thin I/O wiring.
//
// Three outcomes:
//   • not a reply, or resolvable → { deliver } (the pipeline routes it via focus/company as before)
//   • resolvable to a session that must be RESUMED → { deliver } carries the replied-to original so
//     the re-opened worker re-grounds in what it previously said (it lost that memory on close)
//   • an unattributable reply → { clarify } — ask the operator to name the project, never guess
import type { Order } from "../types";
import type { Registry } from "./registry";
import type { Ledger } from "./ledger";
import type { MessageRoutes } from "./message-routes";

/** Shown when a reply can't be tied to any project — instead of silently hitting the company. */
export const UNRESOLVED_REPLY_MESSAGE =
  "I couldn't tell which project that reply was for — name it or /use <project> and resend.";

/** Prepend the message the operator replied to, so a RESUMED worker re-grounds in what it sent
 *  before (the live session had been idle-closed and lost that memory). */
export function repliedContextBrief(original: string, reply: string): string {
  return `You previously sent: «${original}». The operator is replying to that: ${reply}`;
}

export interface ReplyRoutingDeps {
  registry: Registry;
  ledger: Ledger;
  routes: MessageRoutes;
  now?: () => number;
}

export interface ReplyInput {
  chatId: number;
  /** Telegram's reply_to_message.message_id, or undefined when the message isn't a reply. */
  replyToMessageId?: number;
  /** Telegram's reply_to_message.text — the original worker line the operator replied to. */
  replyToText?: string;
  /** The operator's actual message text. */
  text: string;
}

/** `deliver` → call handleMessage(deliver); `clarify` → reply that message and do NOT handleMessage. */
export type ReplyResult = { deliver: string } | { clarify: string };

/**
 * Decide (and enact, via one-shot focus) where a reply routes. Side effects are confined to the
 * registry (setFocus, and — for a closed project — re-registering a focused, resume-seeded entry).
 */
export function routeReply(deps: ReplyRoutingDeps, input: ReplyInput): ReplyResult {
  const { registry, ledger, routes } = deps;
  const now = deps.now ?? (() => Date.now());

  // Not a reply at all → preserve today's normal free-text-to-company (or pinned-focus) behavior.
  if (input.replyToMessageId === undefined) return { deliver: input.text };

  const target = routes.lookup(input.chatId, input.replyToMessageId);
  // A reply we can't attribute must NOT fall through to the company (the observed misroute bug).
  if (!target) return { clarify: UNRESOLVED_REPLY_MESSAGE };

  // Prefer the folder (stable) over the stored session id (changes across idle-close) to re-find
  // the live session — this is what makes a persisted route survive reload/idle-close.
  const open = registry.findByFolder(target.folder);
  if (open && open.status === "running") {
    // Still mid-flight → it remembers what it sent; just focus it, no re-grounding needed.
    registry.setFocus(input.chatId, open.id, "once");
    return { deliver: input.text };
  }

  // The session will be RESUMED (idle in-registry, or fully closed). Ensure there's a focused entry,
  // then carry the replied-to original so the re-opened worker re-grounds in what it said before.
  let id = open?.id;
  if (!id) {
    // Idle-closed / evicted / post-reload gap: rebuild an idle, resumable entry from the folder's
    // last recorded SDK session, so the pipeline's resume branch reopens the same conversation.
    const resumeId = ledger.lastSessionFor(target.folder, input.chatId) ?? "";
    const order: Order = {
      id: crypto.randomUUID(),
      source: "neo",
      folder: target.folder,
      task: input.text,
      chatId: input.chatId,
      createdAt: now(),
    };
    const session = registry.add(order, now());
    registry.setStatus(session.id, "idle"); // idle = the pipeline's resume branch picks it up
    if (resumeId) registry.setSdkSessionId(session.id, resumeId);
    id = session.id;
  }
  registry.setFocus(input.chatId, id, "once");
  const deliver = input.replyToText ? repliedContextBrief(input.replyToText, input.text) : input.text;
  return { deliver };
}
