# Workers share one memory-capped browser

**Status:** accepted (2026-10-10)

The user-level Playwright MCP ran with `--isolated`, so every worker session launched its own
headless Chromium. On 2026-10-10 the host had 53 Chrome processes using about 2.6 GB, plus a leftover
Playwright container. The Chrome DevTools MCP pointed at `127.0.0.1:9222`, where nothing was
listening.

## Decision

1. **One service: `tools/browser/compose.yml`.**
   - The image is `browserless/chromium`, pinned by digest.
   - It is published only on `127.0.0.1:${NEO_BROWSER_PORT}` (9222).
   - Its memory, swap included, is capped at `NEO_BROWSER_MEM` (3g).
   - It runs `NEO_BROWSER_CONCURRENT` browsers (4); up to `NEO_BROWSER_QUEUED` (20) more connections
     wait, and after that it answers 429.
   - Idle sessions close after `NEO_BROWSER_TIMEOUT_MS`.
   - `EXTERNAL` makes `/json/version` advertise the loopback URL that clients actually reach.
   - Each CDP connection gets its own browser process, so workers do not see each other's pages.
     This was checked with two concurrent clients.
2. **Settings, not code.** `tools/browser/browser.env` is tracked and holds no secrets. An untracked
   `browser.local.env` overrides it per machine. The installer refuses an image that is not pinned
   by digest.
3. **One command: `bun tools/browser/install.ts`.**
   - It brings the service up and waits for `/json/version`.
   - With `--wire-mcp` it points the user-level `playwright` MCP (`--cdp-endpoint`) and `chrome` MCP
     (`--browserUrl`) at the service, after backing up `~/.claude.json`.
   - A project's own MCP entries are not touched.
4. **Project test suites keep working.** A suite can attach with `chromium.connectOverCDP` when it
   reads `NEO_BROWSER_CDP` (docs/browser.md). A suite that needs a specific browser or version keeps
   launching its own.

## Considered options

- **A token on the service.** Rejected. It is loopback-only on a single-user host, where every
  local process runs as root and could read a token file anyway. CLAUDE.md's rule ("bind dev
  services to 127.0.0.1 …") is met by the bind, and a token would spread a secret into MCP configs.
- **Playwright's own `run-server`.** Rejected. Its clients must match its Playwright version
  exactly, while CDP is version-tolerant. It also has no queue or memory controls.
- **Cap each worker's browser instead.** Rejected. N workers still mean N browsers. One pool with a
  hard cap is what bounds the host.
- **Wire the MCPs automatically now.** Not done. Rewiring `~/.claude.json` changes every session at
  once, so it is a separate step (`--wire-mcp`). The service runs without it, and the Chrome
  DevTools MCP already points at its port.

## Consequences

- At most four browsers run at once; more workers wait in the queue rather than starting their own.
- The service restarts with Docker (`unless-stopped`).
- Upgrading means pulling the new image and putting its digest in `browser.env`.
