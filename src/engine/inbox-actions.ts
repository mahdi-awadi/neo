// Shared customer-inbox review actions — the SINGLE source of truth for the review loop that
// BOTH frontends drive (web.ts and the Telegram /inbox command). Listing and viewing are pure
// data (no AI); drafting runs the company via runCompanyBrief exactly as the web path does;
// sending posts the approved reply to the gateway. Neither frontend forks the brief or send path.
import type { Inbox, InboxItem } from "./inbox";

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
