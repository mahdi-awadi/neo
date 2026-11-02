// Reach plan P0.5 (G8): machine bearers are compared in constant time; /inbox can have its own secret.
import { test, expect } from "bun:test";
import { bearerOk, inboxSecretOf } from "../src/engine/bearer";

test("bearerOk: exact match only; empty secret never passes; different lengths are just false", () => {
  expect(bearerOk("Bearer s3cret-value", "s3cret-value")).toBe(true);
  expect(bearerOk("Bearer s3cret-valuX", "s3cret-value")).toBe(false); // same length, one byte off
  expect(bearerOk("Bearer s3cret", "s3cret-value")).toBe(false);
  expect(bearerOk("bearer s3cret-value", "s3cret-value")).toBe(false);
  expect(bearerOk("Bearer ", "")).toBe(false);
  expect(bearerOk(null, "s3cret-value")).toBe(false);
});

test("inboxSecretOf: INBOX_INGEST_SECRET when set, else the ingress secret (no change until it is set)", () => {
  expect(inboxSecretOf({ agentIngressSecret: "a", inboxIngestSecret: "b" })).toBe("b");
  expect(inboxSecretOf({ agentIngressSecret: "a", inboxIngestSecret: "" })).toBe("a");
  expect(inboxSecretOf({ agentIngressSecret: "a" })).toBe("a");
});
