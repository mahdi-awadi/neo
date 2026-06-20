import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";

const dir = () => mkdtempSync(join(tmpdir(), "neo-cfg-"));

test("idleCloseMs defaults to 24h", () => {
  expect(loadConfig(dir()).idleCloseMs).toBe(24 * 60 * 60 * 1000);
});

test("config.json overrides idleCloseMs", () => {
  const d = dir();
  writeFileSync(join(d, "config.json"), JSON.stringify({ idleCloseMs: 1000 }));
  expect(loadConfig(d).idleCloseMs).toBe(1000);
});
