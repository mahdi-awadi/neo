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
import type { Order, Provider } from "../types";
import type { Registry } from "./registry";
import type { Ledger, DecisionRow } from "./ledger";
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
  /** The worker SDK new sessions run on — only ITS session ids are valid resume targets. */
  worker?: Provider;
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
  // the live session — this is what makes a persisted route survive reload/idle-close. A running
  // session still remembers what it sent → deliver as-is; otherwise it's RESUMED, so carry the
  // replied-to original to re-ground the re-opened worker in what it said before.
  const open = registry.findByFolder(target.folder);
  const running = open?.status === "running";
  const deliver = running || !input.replyToText ? input.text : repliedContextBrief(input.replyToText, input.text);
  deliverIntoFolder(deps, target.folder, input.chatId, input.text); // focus + (re)seed a resumable entry
  return { deliver };
}

/** Ensure a focused, resumable session exists for `folder` and return the text to handleMessage into
 *  it. The ONE session-seeding path shared by routeReply (the operator replied to a worker line) and
 *  the decision-answer path (the operator answered a tracked decision): a running session is just
 *  focused once; an idle/closed one is rebuilt as an idle, resume-seeded entry from the folder's last
 *  recorded SDK session so the pipeline's resume branch reopens the same conversation. Focus is
 *  mode "once" — a stray next message never sticks to the project. */
export function deliverIntoFolder(deps: ReplyRoutingDeps, folder: string, chatId: number, text: string): string {
  const { registry, ledger } = deps;
  const now = deps.now ?? (() => Date.now());
  const open = registry.findByFolder(folder);
  let id = open?.id;
  if (!id) {
    // Idle-closed / evicted / post-reload gap: rebuild an idle, resumable entry from the folder's
    // last recorded SDK session, so the pipeline's resume branch reopens the same conversation.
    const resumeId = ledger.lastSessionFor(folder, chatId, deps.worker) ?? "";
    const order: Order = { id: crypto.randomUUID(), source: "neo", folder, task: text, chatId, createdAt: now() };
    const session = registry.add(order, now());
    registry.setStatus(session.id, "idle"); // idle = the pipeline's resume branch picks it up
    if (resumeId) registry.setSdkSessionId(session.id, resumeId, deps.worker);
    id = session.id;
  }
  registry.setFocus(chatId, id, "once");
  return text;
}

/** Record an answer to a tracked decision and seed a resume of the project that raised it. The ONE
 *  path behind every answer gesture (a plain REPLY to the decision message, a tapped option button,
 *  or a typed "Other" answer): it marks the row answered — so it drops out of /decisions + the
 *  secretary digest — then, when the decision carries a resumable `folder`, seeds a focused resume
 *  and returns the grounded brief to handleMessage. Returns `undefined` when there is no folder to
 *  resume (e.g. a governor escalation with no project — that unblocks via its in-memory Allow/Deny
 *  resolver instead). Pure bookkeeping + registry seeding; the frontend does the actual send. */
export function answerDecision(
  deps: ReplyRoutingDeps,
  dec: Pick<DecisionRow, "id" | "folder" | "question" | "chatId">,
  answer: string,
  chatId: number,
): { brief: string; homeChat: number } | undefined {
  deps.ledger.resolveDecision(dec.id, answer);
  if (!dec.folder) return undefined;
  // Resume against the ORIGINAL raising chat (the DM the raising session was homed to), NOT the chat
  // the answer arrived on. A decision posted to the unmuted Decisions group is answered THERE; homing
  // the resume to that group would flood it with the project's streamed progress. Fall back to the
  // answer chat only when the decision has no stored raising chat (e.g. it was posted to the DM).
  const homeChat = dec.chatId ?? chatId;
  const brief = repliedContextBrief(dec.question, answer);
  deliverIntoFolder(deps, dec.folder, homeChat, brief);
  return { brief, homeChat };
}
