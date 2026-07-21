import { test, expect } from "bun:test";
import { createMessageRoutes } from "../src/engine/message-routes";
import { openLedger } from "../src/engine/ledger";

const t = (sessionId: string, folder = "/home/x", project = "x") => ({ sessionId, folder, project });

test("remembers which project a sent message belongs to, and reads it back", () => {
  const routes = createMessageRoutes();
  routes.remember(1, 100, t("sess-a"));
  routes.remember(1, 101, t("sess-b"));
  expect(routes.lookup(1, 100)?.sessionId).toBe("sess-a");
  expect(routes.lookup(1, 101)?.sessionId).toBe("sess-b");
});

test("lookup of an unknown message id is undefined", () => {
  const routes = createMessageRoutes();
  expect(routes.lookup(1, 999)).toBeUndefined();
});

test("the in-memory cache evicts oldest entries past the cap, but the ledger still resolves them", () => {
  const led = openLedger(":memory:");
  const routes = createMessageRoutes({ ledger: led, cacheCap: 2 });
  routes.remember(1, 1, t("s1"));
  routes.remember(1, 2, t("s2"));
  routes.remember(1, 3, t("s3")); // evicts id 1 from the cache
  // Cache lost id 1, but the persisted ledger backs it up — no silent loss.
  expect(routes.lookup(1, 1)?.sessionId).toBe("s1");
  expect(routes.lookup(1, 2)?.sessionId).toBe("s2");
  expect(routes.lookup(1, 3)?.sessionId).toBe("s3");
});

test("routes survive a reload: a fresh MessageRoutes over the same ledger still resolves", () => {
  const led = openLedger(":memory:");
  createMessageRoutes({ ledger: led }).remember(7, 55, t("sess-z", "/home/acme", "acme"));
  // Simulate /reload: a brand-new in-memory cache, same ledger.
  const afterReload = createMessageRoutes({ ledger: led });
  expect(afterReload.lookup(7, 55)).toEqual({ sessionId: "sess-z", folder: "/home/acme", project: "acme" });
});

test("without a ledger it still works as a pure in-memory cache", () => {
  const routes = createMessageRoutes();
  routes.remember(2, 9, t("only-cache"));
  expect(routes.lookup(2, 9)?.sessionId).toBe("only-cache");
  expect(routes.lookup(3, 9)).toBeUndefined(); // wrong chat
});
