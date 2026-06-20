import { test, expect } from "bun:test";
import { openInbox } from "../src/engine/inbox";
import { renderInboxList, renderInboxItem, shortId } from "../src/engine/inbox-actions";

test("renderInboxList lists items newest-first with status + from/subject + short id (no AI)", () => {
  const ib = openInbox(":memory:");
  const a = ib.record({ from: "a@x.com", fromName: "Ann", subject: "Quote?", text: "How much?" }, 1000);
  const b = ib.record({ from: "b@x.com", subject: "Refund", text: "Please refund" }, 2000);

  const out = renderInboxList(ib);
  // newest first
  const lines = out.text.split("\n");
  const idxB = lines.findIndex((l) => l.includes("Refund"));
  const idxA = lines.findIndex((l) => l.includes("Quote?"));
  expect(idxB).toBeGreaterThan(-1);
  expect(idxA).toBeGreaterThan(idxB); // a (older) listed after b (newer)
  expect(out.text).toContain("new"); // status shown
  expect(out.text).toContain("Ann"); // fromName shown
  expect(out.text).toContain(shortId(a.id)); // short id shown

  // tappable entries, newest-first, carrying the real id
  expect(out.items.map((i) => i.id)).toEqual([b.id, a.id]);
  expect(out.items[0].label).toContain("Refund");
});

test("renderInboxList reports an empty inbox", () => {
  const ib = openInbox(":memory:");
  expect(renderInboxList(ib).items).toEqual([]);
  expect(renderInboxList(ib).text.toLowerCase()).toContain("empty");
});

test("renderInboxItem shows full body + sender; unknown id returns undefined", () => {
  const ib = openInbox(":memory:");
  const x = ib.record({ from: "c@x.com", fromName: "Cal", subject: "Hi", text: "the full message body here" });

  const view = renderInboxItem(ib, x.id)!;
  expect(view.text).toContain("Cal");
  expect(view.text).toContain("c@x.com");
  expect(view.text).toContain("Hi");
  expect(view.text).toContain("the full message body here");
  expect(view.item.id).toBe(x.id);

  expect(renderInboxItem(ib, "nope")).toBeUndefined();
});

test("renderInboxItem includes the stored draft once drafted", () => {
  const ib = openInbox(":memory:");
  const x = ib.record({ from: "d@x.com", subject: "S", text: "body" });
  ib.setDraft(x.id, "Hi — thanks for reaching out.");
  expect(renderInboxItem(ib, x.id)!.text).toContain("Hi — thanks for reaching out.");
});
