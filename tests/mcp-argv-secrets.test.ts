// ADR-0062: an MCP secret never travels in a worker's argv. The SDK writes every external MCP server config
// into `--mcp-config <JSON>`, and a command line is readable by any process on the host (`ps`, netdata's
// processes view). The engine puts a `${NAME}` reference in the config instead; the Claude CLI expands it
// from the worker's env (checked against the real binary, 2026-10-29), which only the owner can read.
// These tests spawn the SDK against a fake executable that records its argv and env — the real argv.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { neoMcpServers, STITCH_KEY_ENV, type DispatchDeps } from "../src/engine/dispatch";
import { runConfig, setDefaultEnvScrub } from "../src/engine/session-runner";
import { mcpEnvRefs } from "../src/engine/worker-env";

/** A sentinel made at run time: the test needs a value to look for, not a real key. */
const SECRET = `neo-argv-sentinel-${crypto.randomUUID()}`;
let saved: string | undefined;
beforeEach(() => { saved = process.env[STITCH_KEY_ENV]; process.env[STITCH_KEY_ENV] = SECRET; });
afterEach(() => {
  if (saved === undefined) delete process.env[STITCH_KEY_ENV]; else process.env[STITCH_KEY_ENV] = saved;
  setDefaultEnvScrub(undefined);
});

const deps = (): DispatchDeps => ({
  ledger: openLedger(":memory:"), registry: createRegistry(), meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
  trust: openTrustStore(":memory:"), reply: () => {}, askApproval: async () => "deny",
});

/** Spawn the SDK with these options against a fake `claude` that writes its argv and its STITCH env value. */
async function spawned(options: Record<string, unknown>): Promise<{ argv: string; envKey: string }> {
  const dir = mkdtempSync(join(tmpdir(), "neo-argv-"));
  const exe = join(dir, "fake-claude.sh");
  writeFileSync(exe, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv.txt"\nprintf '%s' "$${STITCH_KEY_ENV}" > "${dir}/env.txt"\nexit 1\n`);
  chmodSync(exe, 0o755);
  const q = query({ prompt: "hi", options: { ...options, pathToClaudeCodeExecutable: exe } as never });
  try { for await (const _ of q) { /* the fake exits at once */ } } catch { /* expected: the fake is not claude */ }
  return { argv: readFileSync(join(dir, "argv.txt"), "utf8"), envKey: readFileSync(join(dir, "env.txt"), "utf8") };
}

const operatorServers = () => neoMcpServers(deps(), 1, { dispatch: true, folder: "/home/neo/agent", stitch: true, stitchKey: SECRET, codebaseMemoryBin: "/bin/true", playwright: true });

test("the Stitch server config holds a ${NAME} reference, never the key", () => {
  const stitch = operatorServers().stitch as { headers: Record<string, string> };
  expect(stitch.headers["X-Goog-Api-Key"]).toBe(`\${${STITCH_KEY_ENV}}`);
  const external = Object.entries(operatorServers()).filter(([k]) => k !== "neo").map(([, v]) => v);
  expect(JSON.stringify(external)).not.toContain(SECRET);
});

test("the spawned worker argv never contains the secret; the worker env carries it for the CLI to expand", async () => {
  const { argv, envKey } = await spawned(runConfig({ mcpServers: operatorServers(), env: {} }));
  expect(argv).toContain("--mcp-config");
  expect(argv).toContain(`\${${STITCH_KEY_ENV}}`);
  expect(argv).not.toContain(SECRET);
  expect(envKey).toBe(SECRET);
});

test("strip mode still keeps a key an MCP server config of this run names; a relay key is never kept", async () => {
  setDefaultEnvScrub({ engineKeys: new Set([STITCH_KEY_ENV, "OTHER_ENGINE_KEY"]), relayKeys: new Set(), inherit: new Set(), mode: "strip" });
  const { argv, envKey } = await spawned(runConfig({ mcpServers: operatorServers(), env: {} }));
  expect(argv).not.toContain(SECRET);
  expect(envKey).toBe(SECRET);
  // A relay key stays in the engine even if a server config names it (ADR-0050 §7 wins).
  setDefaultEnvScrub({ engineKeys: new Set(), relayKeys: new Set([STITCH_KEY_ENV]), inherit: new Set(), mode: "report" });
  expect((await spawned(runConfig({ mcpServers: operatorServers(), env: {} }))).envKey).toBe("");
});

test("mcpEnvRefs: the ${NAME} references of external servers only (an in-process sdk server is skipped)", () => {
  expect(mcpEnvRefs({ neo: { type: "sdk", instance: {} }, a: { type: "http", url: "u", headers: { K: "${A_KEY}", L: "${B_KEY:-x}" } }, b: { type: "stdio", command: "c", env: { X: "${C_KEY}" } } }).sort()).toEqual(["A_KEY", "B_KEY", "C_KEY"]);
  expect(mcpEnvRefs(undefined)).toEqual([]);
});
