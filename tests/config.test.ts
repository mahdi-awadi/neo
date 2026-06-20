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

test("stitchApiKey reads STITCH_API_KEY from env (empty when unset)", () => {
  // Hermetic: control the var directly (Bun auto-loads the repo .env into process.env).
  const saved = process.env.STITCH_API_KEY;
  try {
    delete process.env.STITCH_API_KEY;
    expect(loadConfig(dir()).stitchApiKey).toBe("");
    process.env.STITCH_API_KEY = "stitch-test-key";
    expect(loadConfig(dir()).stitchApiKey).toBe("stitch-test-key");
  } finally {
    if (saved === undefined) delete process.env.STITCH_API_KEY;
    else process.env.STITCH_API_KEY = saved;
  }
});
