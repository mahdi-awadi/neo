import { test, expect } from "bun:test";
import { createMessageRoutes } from "../src/engine/message-routes";

test("remembers which session a sent message belongs to, and reads it back", () => {
  const routes = createMessageRoutes();
  routes.remember(100, "sess-a");
  routes.remember(101, "sess-b");
  expect(routes.sessionFor(100)).toBe("sess-a");
  expect(routes.sessionFor(101)).toBe("sess-b");
});

test("sessionFor an unknown message id is undefined", () => {
  const routes = createMessageRoutes();
  expect(routes.sessionFor(999)).toBeUndefined();
});

test("evicts the oldest entries past the cap so the map can't grow without bound", () => {
  const routes = createMessageRoutes(2);
  routes.remember(1, "s1");
  routes.remember(2, "s2");
  routes.remember(3, "s3"); // evicts id 1
  expect(routes.sessionFor(1)).toBeUndefined();
  expect(routes.sessionFor(2)).toBe("s2");
  expect(routes.sessionFor(3)).toBe("s3");
});
