import { test, expect } from "bun:test";
import { openInbox } from "../src/engine/inbox";

test("records and lists inbound customer messages, newest first (plain data, no AI)", () => {
  const ib = openInbox(":memory:");
  const a = ib.record(
    { from: "a@x.com", fromName: "A", to: "info@tech-gate.online", subject: "hi", text: "hello", messageId: "<1>" },
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

test("record defaults receivedAt and assigns a unique id; status starts 'new'", () => {
  const ib = openInbox(":memory:");
  const x = ib.record({ from: "c@x.com", subject: "s", text: "t" });
  expect(x.id).toBeTruthy();
  expect(x.receivedAt).toBeGreaterThan(0);
  expect(x.status).toBe("new");
  expect(x.fromName).toBe(""); // optional fields default to empty
});
