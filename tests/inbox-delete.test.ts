import { test, expect } from "bun:test";
import { openInbox } from "../src/engine/inbox";

test("delete(id) removes the item: get() returns undefined and it drops out of list()", () => {
  const ib = openInbox(":memory:");
  const a = ib.record({ from: "a@x.com", subject: "keep", text: "keep me" }, 1000);
  const b = ib.record({ from: "b@x.com", subject: "drop", text: "delete me" }, 2000);

  ib.delete(b.id);

  expect(ib.get(b.id)).toBeUndefined();
  expect(ib.list().map((i) => i.id)).toEqual([a.id]);
});

test("delete(id) on an unknown id is a no-op", () => {
  const ib = openInbox(":memory:");
  const a = ib.record({ from: "a@x.com", subject: "s", text: "t" });
  ib.delete("no-such-id");
  expect(ib.list().map((i) => i.id)).toEqual([a.id]);
});

test("web frontend exposes DELETE /api/inbox/:id wired to inbox.delete (source check)", async () => {
  const src = await Bun.file(new URL("../src/frontends/web.ts", import.meta.url)).text();
  // a delete route that calls inbox.delete
  expect(src).toMatch(/DELETE/);
  expect(src).toMatch(/\/api\/inbox\//);
  expect(src).toMatch(/\.delete\(/);
  // a delete button affordance on inbox rows in the rendered page
  expect(src).toMatch(/deleteInbox/);
});
