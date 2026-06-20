import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTrustStore } from "../src/engine/trust";

test("a folder is untrusted by default; setTrust toggles it", () => {
  const t = openTrustStore(":memory:");
  expect(t.isTrusted("/p/a")).toBe(false);
  t.setTrust("/p/a", true);
  expect(t.isTrusted("/p/a")).toBe(true);
  expect(t.list()).toEqual(["/p/a"]);
  t.setTrust("/p/a", false);
  expect(t.isTrusted("/p/a")).toBe(false);
  expect(t.list()).toEqual([]);
});

test("trust persists across reopen", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trust-")), "trust.db");
  openTrustStore(path).setTrust("/p/b", true);
  expect(openTrustStore(path).isTrusted("/p/b")).toBe(true);
});
