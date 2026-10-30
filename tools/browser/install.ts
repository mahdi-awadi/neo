// Neo's shared browser (ADR-0032): bring the one memory-capped Chromium service up, check it, and —
// with --wire-mcp — point the user-level Playwright and Chrome DevTools MCPs at it so a worker no
// longer launches a browser of its own. The decisions are pure and tested (tests/browser-service.test.ts);
// main() is the thin docker/IO wrapper.
//
//   bun tools/browser/install.ts               up -d, wait until healthy, print the endpoints
//   bun tools/browser/install.ts --wire-mcp    …and rewire ~/.claude.json (a backup is written first)
//   bun tools/browser/install.ts --down        stop and remove the service
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvFile, pickSetting } from "../lib/env-file";

export interface BrowserSettings {
  image: string;
  port: number;
  mem: string;
  concurrent: number;
  queued: number;
  timeoutMs: number;
}

const posInt = (v: string | undefined): number | undefined => (v && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined);
const memSize = (v: string | undefined): string | undefined => (v && /^\d+[kmg]$/i.test(v) ? v.toLowerCase() : undefined);

/** Settings from env layers, later layers winning; an invalid value keeps the earlier one (fails
 *  closed). The image must be pinned by digest. */
export function browserSettings(layers: Array<Record<string, string>>): BrowserSettings {
  const pick = <T>(key: string, parse: (v: string | undefined) => T | undefined): T | undefined => pickSetting(layers, key, parse);
  const image = pick("NEO_BROWSER_IMAGE", (v) => v || undefined);
  if (!image || !/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("NEO_BROWSER_IMAGE must be pinned by digest (…@sha256:<64 hex>)");
  return {
    image,
    port: pick("NEO_BROWSER_PORT", posInt) ?? 9222,
    mem: pick("NEO_BROWSER_MEM", memSize) ?? "3g",
    concurrent: pick("NEO_BROWSER_CONCURRENT", posInt) ?? 4,
    queued: pick("NEO_BROWSER_QUEUED", posInt) ?? 20,
    timeoutMs: pick("NEO_BROWSER_TIMEOUT_MS", posInt) ?? 600_000,
  };
}

/** The user-level MCP entries that attach to the shared browser instead of launching their own. */
export function mcpWiring(port: number) {
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest", "--cdp-endpoint", endpoint, "--isolated"], env: {} },
    chrome: { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp", "--browserUrl", endpoint], env: {} },
  };
}

/** ~/.claude.json with ONLY the user-level `playwright` and `chrome` MCP entries pointed at the shared
 *  browser: their command and args are replaced, any other field they carry (env, …) is kept. A
 *  project's own MCP choices are left alone. Pure: returns a new object. */
export function wireUserMcp(claudeJson: Record<string, unknown>, wiring: ReturnType<typeof mcpWiring>): Record<string, unknown> {
  const servers = { ...((claudeJson.mcpServers as Record<string, Record<string, unknown>> | undefined) ?? {}) };
  for (const name of ["playwright", "chrome"] as const) {
    const was = servers[name] ?? {};
    servers[name] = { ...wiring[name], ...was, type: wiring[name].type, command: wiring[name].command, args: wiring[name].args, env: (was.env as Record<string, string> | undefined) ?? wiring[name].env };
  }
  return { ...claudeJson, mcpServers: servers };
}

/** `docker compose …` arguments: the tracked settings, then the machine-local overrides if present. */
export function composeArgs(kit: string, hasLocal: boolean, cmd: string[]): string[] {
  return [
    "compose", "-p", "neo-browser", "-f", join(kit, "compose.yml"),
    "--env-file", join(kit, "browser.env"),
    ...(hasLocal ? ["--env-file", join(kit, "browser.local.env")] : []),
    ...cmd,
  ];
}

async function healthy(port: number, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(2_000);
  }
  return false;
}

if (import.meta.main) {
  const kit = import.meta.dir;
  const local = join(kit, "browser.local.env");
  const hasLocal = existsSync(local);
  const s = browserSettings([parseEnvFile(readFileSync(join(kit, "browser.env"), "utf8")), ...(hasLocal ? [parseEnvFile(readFileSync(local, "utf8"))] : [])]);
  const args = process.argv.slice(2);
  const docker = (cmd: string[]) => Bun.spawnSync(["docker", ...composeArgs(kit, hasLocal, cmd)], { stdout: "inherit", stderr: "inherit" }).exitCode;
  if (args.includes("--down")) process.exit(docker(["down"]));
  if (docker(["up", "-d"]) !== 0) process.exit(1);
  if (!(await healthy(s.port, 60_000))) {
    console.error(`neo-browser did not answer on 127.0.0.1:${s.port} within 60 s — see: docker logs neo-browser`);
    process.exit(1);
  }
  console.log(`neo-browser up: 127.0.0.1:${s.port} · memory cap ${s.mem} · ${s.concurrent} concurrent, ${s.queued} queued`);
  console.log(`  CDP (Playwright connectOverCDP, Chrome DevTools MCP --browserUrl): http://127.0.0.1:${s.port}`);
  if (args.includes("--wire-mcp")) {
    const path = join(homedir(), ".claude.json");
    const backup = `${path}.bak-neo-browser-${Date.now()}`;
    copyFileSync(path, backup);
    const next = wireUserMcp(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>, mcpWiring(s.port));
    // Write-then-rename: a reader never sees a half-written file.
    const tmp = `${path}.neo-browser-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, path);
    console.log(`  user MCPs playwright + chrome now attach to it (backup: ${backup}); new sessions pick it up.`);
  }
}
