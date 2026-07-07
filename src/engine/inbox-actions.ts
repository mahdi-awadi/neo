// Shared customer-inbox review actions — the SINGLE source of truth for the review loop that
// BOTH frontends drive (web.ts and the Telegram /inbox command). Listing and viewing are pure
// data (no AI); drafting runs the company via runCompanyBrief exactly as the web path does;
// sending posts the approved reply to the gateway. Neither frontend forks the brief or send path.
import type { Inbox, InboxItem } from "./inbox";
import { runCompanyBrief, type IngressDeps } from "./ingress";

const STATUS_ICON: Record<string, string> = {
  new: "🆕",
  "with-agent": "⏳",
  drafted: "✍️",
  replied: "✅",
};

/** Short, git-like id for display in chat (the full id rides the inline-button callback). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A tappable inbox row — a frontend renders these as buttons (callback carries the full id). */
export interface InboxListEntry {
  id: string;
  label: string;
  status: string;
}

/** Newest-first inbox list: a text summary + tappable entries. Pure data — no AI. */
export function renderInboxList(inbox: Inbox, limit = 20): { text: string; items: InboxListEntry[] } {
  const items = inbox.list(limit);
  if (items.length === 0) return { text: "📭 Inbox is empty — no customer messages.", items: [] };
  const text = [
    "📥 Inbox — customer messages (tap one to view):",
    ...items.map(
      (i) =>
        `${STATUS_ICON[i.status] ?? ""} ${i.status} · ${i.fromName || i.from} · ${i.subject || "(no subject)"} · ${shortId(i.id)}`,
    ),
  ].join("\n");
  return {
    text,
    items: items.map((i) => ({
      id: i.id,
      label: `${STATUS_ICON[i.status] ?? ""} ${i.fromName || i.from}: ${i.subject || "(no subject)"}`,
      status: i.status,
    })),
  };
}

/** Full detail of one item: sender + subject + body (+ draft once drafted). Pure data — no AI. */
export interface InboxItemView {
  text: string;
  item: InboxItem;
}
export function renderInboxItem(inbox: Inbox, id: string): InboxItemView | undefined {
  const item = inbox.get(id);
  if (!item) return undefined;
  const lines = [
    `${STATUS_ICON[item.status] ?? ""} ${item.status} · ${shortId(item.id)}`,
    `From: ${item.fromName || item.from} <${item.from}>`,
    `Subject: ${item.subject || "(no subject)"}`,
    "",
    item.text || "(no body)",
  ];
  if (item.draft) lines.push("", "📝 Draft:", item.draft);
  return { text: lines.join("\n"), item };
}

// ── Drafting: send an item to the company to draft a reply (the exact web /api/inbox/draft path) ──

/** Config the brief weaves in: the booking URL the CTA points at, and the customer-facing name the
 *  email signs off as. Both optional — empty values fall back gracefully. */
export interface DraftBriefOpts {
  meetingLink?: string;
  businessName?: string;
}

/** The drafting brief — VERBATIM the string POST /api/inbox/draft builds, so neither frontend
 *  forks the prompt. The reply is a COMPLETE one-shot email (answer + a brief on what we do + a
 *  meeting CTA), never a back-and-forth chat, signed off as the business (never as "Neo").
 *  `meetingLink` is the booking URL the CTA points at; with none, it invites the customer to
 *  propose times. `instructions` (optional) steers it; a prior draft is carried for revision. */
export function buildDraftBrief(item: InboxItem, instructions = "", opts: DraftBriefOpts = {}): string {
  const instr = instructions.trim();
  const link = (opts.meetingLink ?? "").trim();
  const business = (opts.businessName ?? "").trim();
  return (
    "A customer emailed the business. Draft a COMPLETE one-shot email reply that NEO (the operator) will review, edit if needed, and SEND — you are NOT contacting the customer yourself; Neo sends it. Output ONLY the email body, ready to send: no preamble, no headings, no '---' separators — start at the greeting.\n\n" +
    "Write it as an email, NOT a chat: do NOT ask the customer follow-up questions and do NOT end on a question. Answer what they asked directly and confidently, add one or two sentences on what we do that is relevant to their inquiry, and close with a clear call to action to book a short meeting" +
    (link
      ? ` — point them to this booking link to pick a time: ${link}`
      : " — invite them to a short intro call and ask them to propose two or three times that suit them") +
    `.\n\nSign the email off as ${business || "the business"} — never as "Neo" or "the operator".\n\n` +
    `From: ${item.fromName || item.from} <${item.from}>\nSubject: ${item.subject}\n\n${item.text}` +
    (instr ? `\n\nNeo's instructions for this reply: ${instr}` : "") +
    (item.draft ? `\n\nYour previous draft (revise it per Neo's instructions above):\n${item.draft}` : "")
  );
}

/** Send an inbox item to the company to draft a reply: mark it with-agent, run the company on the
 *  shared brief, store the draft (→ status 'drafted'). NEVER sent — awaits operator approval. */
export async function draftInboxReply(
  inbox: Inbox,
  id: string,
  instructions: string,
  briefDeps: IngressDeps,
): Promise<string | undefined> {
  const item = inbox.get(id);
  if (!item) return undefined;
  inbox.setStatus(item.id, "with-agent");
  const draft = await runCompanyBrief(
    buildDraftBrief(item, instructions, {
      meetingLink: briefDeps.cfg.meetingLink,
      businessName: briefDeps.cfg.businessName,
    }),
    briefDeps,
    { tainted: true }, // customer email is untrusted input — the drafting worker gets zero tools
  );
  inbox.setDraft(item.id, draft);
  return draft;
}

// ── Sending: post the approved reply to the gateway (the exact web /api/inbox/send path) ──

type FetchFn = typeof fetch;

/** POST an approved reply to the gateway's /send (which relays it via the Cloudflare Worker).
 *  VERBATIM the helper web.ts used — Neo holds no Cloudflare creds, so the gateway sends. */
export async function sendViaGateway(
  url: string,
  secret: string,
  msg: { to: string; subject: string; text: string; inReplyTo?: string },
  fetchImpl: FetchFn = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(msg),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reply subject: prefix "Re:" once (web parity), falling back to "Re:" when there is no subject. */
export function replySubject(item: InboxItem): string {
  return item.subject && !item.subject.startsWith("Re:") ? "Re: " + item.subject : item.subject || "Re:";
}

/** Send the operator-approved (possibly edited) reply to the customer via the gateway, then mark
 *  the item 'replied'. On any failure or empty/unknown input, the status is left untouched. The
 *  caller is responsible for the approval gate before invoking this (external action). */
export async function sendInboxReply(
  inbox: Inbox,
  id: string,
  reply: string,
  gateway: { url: string; secret: string },
  fetchImpl: FetchFn = fetch,
): Promise<boolean> {
  const item = inbox.get(id);
  const text = reply.trim();
  if (!item || !text) return false;
  const sent = await sendViaGateway(
    gateway.url,
    gateway.secret,
    { to: item.from, subject: replySubject(item), text, inReplyTo: item.messageId },
    fetchImpl,
  );
  if (sent) inbox.setStatus(item.id, "replied");
  return sent;
}
