import { test, expect } from "bun:test";
import { openInbox } from "../src/engine/inbox";

test("records and lists inbound customer messages, newest first (plain data, no AI)", () => {
  const ib = openInbox(":memory:");
  const a = ib.record(
    { from: "a@x.com", fromName: "A", to: "info@example.com", subject: "hi", text: "hello", messageId: "<1>" },
    1000,
  );
  ib.record({ from: "b@x.com", subject: "yo", text: "hey", messageId: "<2>" }, 2000);

  expect(a.id).toBeTruthy();
  expect(a.status).toBe("new");
  expect(a.receivedAt).toBe(1000);

  const list = ib.list();
  expect(list.map((i) => i.from)).toEqual(["b@x.com", "a@x.com"]); // newest first
  expect(ib.get(a.id)?.subject).toBe("hi");
  expect(ib.get(a.id)?.text).toBe("hello");
});

test("setDraft stores the draft and marks 'drafted'; setStatus updates status", () => {
  const ib = openInbox(":memory:");
  const x = ib.record({ from: "a@x.com", subject: "s", text: "t" });
  ib.setDraft(x.id, "Hi, thanks for reaching out.");
  const d = ib.get(x.id)!;
  expect(d.draft).toBe("Hi, thanks for reaching out.");
  expect(d.status).toBe("drafted");
  ib.setStatus(x.id, "replied");
  expect(ib.get(x.id)?.status).toBe("replied");
});

test("record defaults receivedAt and assigns a unique id; status starts 'new'", () => {
  const ib = openInbox(":memory:");
  const x = ib.record({ from: "c@x.com", subject: "s", text: "t" });
  expect(x.id).toBeTruthy();
  expect(x.receivedAt).toBeGreaterThan(0);
  expect(x.status).toBe("new");
  expect(x.fromName).toBe(""); // optional fields default to empty
});

test("draftVersion starts at 0 and bumps on every setDraft (the send idempotency key)", () => {
  const ib = openInbox(":memory:");
  const x = ib.record({ from: "a@x.com", subject: "s", text: "t" });
  expect(x.draftVersion).toBe(0);
  ib.setDraft(x.id, "one");
  ib.setDraft(x.id, "one"); // same text, still a new version — an edit happened
  expect(ib.get(x.id)?.draftVersion).toBe(2);
});

test("an inbox file from before draft_version gains the column (existing rows at 0)", () => {
  const path = `${require("node:os").tmpdir()}/inbox-legacy-${crypto.randomUUID()}.db`;
  const { Database } = require("bun:sqlite");
  const legacy = new Database(path);
  legacy.run(`CREATE TABLE inbox (id TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'email', from_addr TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '', to_addr TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
    received_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', draft TEXT NOT NULL DEFAULT '')`);
  legacy.run(`INSERT INTO inbox (id, from_addr, received_at, status, draft) VALUES ('old', 'a@x', 1, 'drafted', 'hi')`);
  legacy.close();
  const ib = openInbox(path);
  expect(ib.get("old")).toMatchObject({ draft: "hi", draftVersion: 0 });
  ib.setDraft("old", "edited");
  expect(ib.get("old")?.draftVersion).toBe(1);
});
