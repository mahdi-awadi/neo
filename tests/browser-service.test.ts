// ADR-0032: one shared, memory-capped browser for workers. The installer's decisions are pure and
// tested here; the docker/IO wrapper around them is exercised by hand (docs/browser.md).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { browserSettings, mcpWiring, wireUserMcp, composeArgs } from "../tools/browser/install";
import { parseEnvFile } from "../tools/lib/env-file";

const KIT = join(import.meta.dir, "..", "tools", "browser");

test("the tracked settings pin the image by digest, bind loopback, cap memory and limit concurrency", () => {
  const s = browserSettings([parseEnvFile(readFileSync(join(KIT, "browser.env"), "utf8"))]);
  expect(s.image).toMatch(/^ghcr\.io\/browserless\/chromium@sha256:[0-9a-f]{64}$/);
  expect(s.port).toBe(9222);
  expect(s.mem).toBe("3g");
  expect(s.concurrent).toBeGreaterThan(0);
  const compose = readFileSync(join(KIT, "compose.yml"), "utf8");
  expect(compose).toContain('"127.0.0.1:${NEO_BROWSER_PORT}:3000"'); // never 0.0.0.0
  expect(compose).toContain("mem_limit: ${NEO_BROWSER_MEM}");
  expect(compose).toContain("CONCURRENT: ${NEO_BROWSER_CONCURRENT}");
});

test("a machine-local file overrides the tracked settings; a bad value fails closed to the tracked one", () => {
  const base = parseEnvFile("NEO_BROWSER_IMAGE=img@sha256:" + "a".repeat(64) + "\nNEO_BROWSER_PORT=9222\nNEO_BROWSER_MEM=3g\nNEO_BROWSER_CONCURRENT=4\nNEO_BROWSER_QUEUED=20\nNEO_BROWSER_TIMEOUT_MS=600000\n");
  const s = browserSettings([base, parseEnvFile("# local\nNEO_BROWSER_MEM=2g\nNEO_BROWSER_CONCURRENT=nope\n")]);
  expect(s.mem).toBe("2g");
  expect(s.concurrent).toBe(4);
  expect(() => browserSettings([parseEnvFile("NEO_BROWSER_IMAGE=chromium:latest")])).toThrow(/digest/);
});

test("MCP wiring: Playwright attaches over CDP (no own browser), Chrome DevTools to the same endpoint", () => {
  const w = mcpWiring(9222);
  expect(w.playwright.args).toContain("--cdp-endpoint");
  expect(w.playwright.args).toContain("http://127.0.0.1:9222");
  expect(w.playwright.args).toContain("--isolated"); // a fresh context per session, inside the shared browser
  expect(w.playwright.args).not.toContain("--headless");
  expect(w.chrome.args).toEqual(expect.arrayContaining(["--browserUrl", "http://127.0.0.1:9222"]));
});

test("wireUserMcp rewrites only the user-level playwright/chrome entries and keeps everything else", () => {
  const before = {
    mcpServers: {
      playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest", "--headless", "--no-sandbox", "--isolated"], env: {} },
      chrome: { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp", "--browserUrl", "http://127.0.0.1:9222"], env: {} },
      "codebase-memory": { type: "stdio", command: "/x" },
    },
    projects: { "/home/eticket-v3": { mcpServers: { "chrome-devtools": { type: "stdio", command: "npx", args: ["chrome-devtools-mcp@latest"] } } } },
    other: 1,
  };
  const after = wireUserMcp(before, mcpWiring(9222)) as typeof before;
  expect(after.mcpServers.playwright.args).toEqual(mcpWiring(9222).playwright.args);
  expect(after.mcpServers.chrome.args).toEqual(mcpWiring(9222).chrome.args);
  expect(after.mcpServers["codebase-memory"]).toEqual(before.mcpServers["codebase-memory"]);
  expect(after.projects).toEqual(before.projects); // a project's own MCP choice is its own
  expect(after.other).toBe(1);
  expect(before.mcpServers.playwright.args).toContain("--headless"); // pure: the input is untouched
  const withEnv = wireUserMcp({ mcpServers: { playwright: { command: "npx", args: ["x"], env: { DEBUG: "pw:*" } } } }, mcpWiring(9222)) as { mcpServers: { playwright: { env: Record<string, string> } } };
  expect(withEnv.mcpServers.playwright.env).toEqual({ DEBUG: "pw:*" }); // an entry's own env survives
});

test("compose is run with the tracked settings, then the machine-local overrides when present", () => {
  expect(composeArgs(KIT, false, ["up", "-d"])).toEqual(["compose", "-p", "neo-browser", "-f", join(KIT, "compose.yml"), "--env-file", join(KIT, "browser.env"), "up", "-d"]);
  expect(composeArgs(KIT, true, ["down"])).toContain(join(KIT, "browser.local.env"));
});
