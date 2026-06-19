import { test, expect } from "bun:test";
import { createSessionStore } from "../src/engine/web-session";

const store = () => createSessionStore({ secret: "s3cr3t", ttlSec: 1000 });

test("issues a token that verifies back to the user id", () => {
  const s = store();
  const tok = s.issue(555, 1000);
  expect(s.verify(tok, 1500)).toBe(555);
});

test("rejects a tampered token", () => {
  const s = store();
  const tok = s.issue(555, 1000);
  const bad = tok.slice(0, -1) + (tok.endsWith("a") ? "b" : "a"); // flip last char
  expect(s.verify(bad, 1500)).toBeUndefined();
});

test("rejects an expired token", () => {
  const s = store();
  const tok = s.issue(555, 1000); // expires at 2000
  expect(s.verify(tok, 2001)).toBeUndefined();
});

test("rejects a token signed with a different secret", () => {
  const tok = createSessionStore({ secret: "one", ttlSec: 1000 }).issue(555, 1000);
  expect(createSessionStore({ secret: "two", ttlSec: 1000 }).verify(tok, 1500)).toBeUndefined();
});

test("rejects malformed tokens", () => {
  const s = store();
  expect(s.verify("garbage", 1500)).toBeUndefined();
  expect(s.verify("a.b", 1500)).toBeUndefined();
});
