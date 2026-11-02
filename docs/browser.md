# The shared browser (ADR-0032)

One memory-capped Chromium service for every worker, on `127.0.0.1:9222` (loopback only).

## Run it

```bash
bun tools/browser/install.ts              # up -d + health check
bun tools/browser/install.ts --wire-mcp   # also point the user-level Playwright/Chrome MCPs at it
bun tools/browser/install.ts --down       # stop it
docker stats neo-browser --no-stream      # memory against the cap
```

Settings live in `tools/browser/browser.env`:

| Setting | Default | Meaning |
|---|---|---|
| `NEO_BROWSER_IMAGE` | (pinned digest) | The image, pinned by digest. |
| `NEO_BROWSER_PORT` | 9222 | The loopback port. |
| `NEO_BROWSER_MEM` | 3g | Memory cap for the whole service. |
| `NEO_BROWSER_CONCURRENT` | 4 | Browsers running at once. |
| `NEO_BROWSER_QUEUED` | 20 | Connections that may wait for a free browser. |
| `NEO_BROWSER_TIMEOUT_MS` | 600000 | Idle sessions close after this. |

To change a setting on one machine, put it in `tools/browser/browser.local.env` (untracked).

## Use it from a project

The service speaks CDP. Each connection gets its own browser, so suites and workers do not share
pages.

- **Playwright MCP / Chrome DevTools MCP:** run `install.ts --wire-mcp`. The MCP entries become
  `@playwright/mcp --cdp-endpoint http://127.0.0.1:9222 --isolated` and
  `chrome-devtools-mcp --browserUrl http://127.0.0.1:9222`.
- **A Playwright test suite:** attach when the endpoint is set, and launch your own otherwise:

  ```ts
  // playwright.config.ts (or a fixture)
  import { chromium } from "@playwright/test";
  const cdp = process.env.NEO_BROWSER_CDP; // e.g. http://127.0.0.1:9222
  // in a fixture: const browser = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch();
  ```

  Pass `NEO_BROWSER_CDP` to workers through `config.json` `workerEnv` when a project should use it.
  A suite that needs Firefox/WebKit or a pinned browser version keeps launching its own.
- **Inside Docker:** a project container reaches the host loopback only with host networking
  (`network_mode: host`). Otherwise keep the suite's own browser.

## Limits

At most `NEO_BROWSER_CONCURRENT` browsers run at once. Further connections wait, up to
`NEO_BROWSER_QUEUED`, and then get HTTP 429. The memory cap includes swap: when it is reached, Docker
kills browser processes inside the container, not the host's other services.
