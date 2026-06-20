// The customer inbox — plain data, NO AI. Inbound customer messages (email now, other channels
// later) are stored here and shown in the web dashboard for the operator to review. Receiving,
// storing, and displaying a message never involves Claude or Gemini; the agent is invoked only
// when the operator explicitly sends an item to it. Backed by bun:sqlite, like the ledger.
import { Database } from "bun:sqlite";

export type InboxStatus = "new" | "with-agent" | "drafted" | "replied";

/** A received customer message (channel-agnostic; email fills these in). */
export interface InboxInput {
  channel?: string; // "email" (default), later "whatsapp" | "web" | ...
  from: string;
  fromName?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
}

export interface InboxItem extends Required<Omit<InboxInput, "channel">> {
  id: string;
  channel: string;
  receivedAt: number;
  status: InboxStatus;
  draft: string; // the agent's draft reply (empty until drafted)
}

export interface Inbox {
  /** Store a received message (status "new"). Pure data — no AI. */
  record(input: InboxInput, now?: number): InboxItem;
  /** Newest-first list for the dashboard. */
  list(limit?: number): InboxItem[];
  get(id: string): InboxItem | undefined;
  /** Update status (e.g. "with-agent" while drafting, "replied" after the operator sends). */
  setStatus(id: string, status: InboxStatus): void;
  /** Store the agent's draft reply and mark the item "drafted" (awaiting operator approval). */
  setDraft(id: string, draft: string): void;
}

type Row = {
  id: string;
  channel: string;
  from_addr: string;
  from_name: string;
  to_addr: string;
  subject: string;
  body_text: string;
  body_html: string;
  message_id: string;
  received_at: number;
  status: string;
  draft: string;
};

function rowToItem(r: Row): InboxItem {
  return {
    id: r.id,
    channel: r.channel,
    from: r.from_addr,
    fromName: r.from_name,
    to: r.to_addr,
    subject: r.subject,
    text: r.body_text,
    html: r.body_html,
    messageId: r.message_id,
    receivedAt: r.received_at,
    status: r.status as InboxStatus,
    draft: r.draft,
  };
}

export function openInbox(path: string): Inbox {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS inbox (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL DEFAULT 'email',
    from_addr TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    to_addr TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    received_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    draft TEXT NOT NULL DEFAULT ''
  )`);

  return {
    record(input, now = Date.now()) {
      const item: InboxItem = {
        id: crypto.randomUUID(),
        channel: input.channel ?? "email",
        from: input.from,
        fromName: input.fromName ?? "",
        to: input.to ?? "",
        subject: input.subject ?? "",
        text: input.text ?? "",
        html: input.html ?? "",
        messageId: input.messageId ?? "",
        receivedAt: now,
        status: "new",
        draft: "",
      };
      db.run(
        `INSERT INTO inbox (id,channel,from_addr,from_name,to_addr,subject,body_text,body_html,message_id,received_at,status,draft)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [item.id, item.channel, item.from, item.fromName, item.to, item.subject, item.text, item.html, item.messageId, item.receivedAt, item.status, item.draft],
      );
      return item;
    },
    list(limit = 100) {
      return (db.query(`SELECT * FROM inbox ORDER BY received_at DESC LIMIT ?`).all(limit) as Row[]).map(rowToItem);
    },
    get(id) {
      const r = db.query(`SELECT * FROM inbox WHERE id = ?`).get(id) as Row | null;
      return r ? rowToItem(r) : undefined;
    },
    setStatus(id, status) {
      db.run(`UPDATE inbox SET status = ? WHERE id = ?`, [status, id]);
    },
    setDraft(id, draft) {
      db.run(`UPDATE inbox SET draft = ?, status = 'drafted' WHERE id = ?`, [draft, id]);
    },
  };
}
