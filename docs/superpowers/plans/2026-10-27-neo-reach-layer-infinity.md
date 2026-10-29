---
approval: required
---

# Neo reach layer: other servers, connectors, and Infinity (RAP) in its best role

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking. Read `CLAUDE.md` first.

**Status (2026-10-29):** only the Neo-local hardening P0.3–P0.5 is built (on `dev`, restart-gated):
the guard treats SSH private keys as secrets, Neo's tools are trusted by provenance, and the machine
bearers are compared in constant time with an optional own `/inbox` secret. Everything else (the
spikes, the gateway, prod nodes, connectors, host hygiene, the firewall) waits for the operator's 11
decisions (§12); "full permission for DEV work" does not cover prod access or deploys.

**Original status:** PLAN ONLY (2026-10-27). Nothing is built. No code, config, server or loop was changed to
write it. It needs the operator's approval: it touches auth, production access and deploys.

**Goal:** Neo reaches the operator's other servers and services the way ChatGPT Dots and Claude Duet
reach theirs: read freely, act only after approval. The difference: every call goes through Neo's
governor and ledger, credentials never reach a worker, production stays read-only by default, and
heavy builds and tests leave this host.

**Architecture:** The brain does not change: Neo's engine plus Claude Agent SDK workers on the
subscription. A new engine module, the **reach gateway**, becomes the only way a worker touches
another machine or a SaaS API. Workers see it as one in-process MCP server (`reach`). Behind it are
MCP over SSH to small **node agents** on each server, vendor remote MCP servers, the existing
`tool_api` relay, and an engine-owned **async plane** for long jobs and node events. Infinity's
protocol (RAP) competes for the async plane in a pre-registered head-to-head. The Infinity runtime is
not used.

**Tech stack:** Bun + TypeScript engine, `bun:sqlite` ledger, `@anthropic-ai/claude-agent-sdk`
0.3.310 (bundles Claude Code 2.1.310), an MCP client library in the gateway (version pinned in P1),
Docker node agents, OpenSSH forced commands.

**Evidence legend.** Every factual claim carries one tag:
- **[V]** verified in this session: a file and line, a read-only command, or a read-only ledger query.
- **[D]** official documentation fetched in this session (URL in §14).
- **[S]** press or other secondary source (URL in §14).
- **[U]** not verified: a memory note, an assumption, or something not checkable read-only. P0
  checks every [U] that a decision depends on.

---

## 0. Decisions in one page

| # | Decision | Main reason |
|---|---|---|
| 1 | The brain stays Neo + Claude Agent SDK on the subscription. The Infinity runtime, Infinity Code and the Infinity Lambda deployment are **not used**. | Infinity runs models only through its `ModelProvider` trait: AWS Bedrock or API-key backends [V]. Neo's subscription rule is settled. Neo's governor lives in `canUseTool` + a PreToolUse hook [V], which Infinity does not have. |
| 2 | One new engine module, the **reach gateway**, is the only path from a worker to another server or SaaS API. Workers get one in-process MCP server, `reach`. | Credentials then stay in the engine. Today a remote MCP header given to a worker is readable in `/proc/<pid>/cmdline` [V]. |
| 3 | Synchronous tools use **plain MCP**: prod over **MCP-over-SSH with a forced-command, IP-bound read key** (no new open port); SaaS over vendor remote MCP (Cloudflare, GitHub) or the existing `tool_api` relay (Coolify, Hostinger); Google stays on the **claude.ai hosted connectors**, now governed. | MCP is native to the SDK [D] and already in production code (Stitch) [V]. SSH is how prod is reached today [V]. Hosted connectors are already loaded into workers [V]. |
| 4 | **Infinity's best role:** RAP as the push transport of the engine-owned **async plane** (node events, long jobs, tool-initiated approvals), with Neo's engine as the RAP runtime endpoint. It is adopted **only where it wins** the P0 head-to-head against engine-polled MCP (incl. the MCP Tasks extension) and signed webhooks. | RAP's unique strengths are push callbacks and subscription lifecycle [V]. Its weak points are maturity and auth [V]. MCP now covers long calls too [D]. Measure, then choose. |
| 5 | The governor gains **action classes** (`read`, `act`, `prod-act`) keyed on SDK provenance, not tool names. Trust lifts only `read`. Every `act` asks first (approve-before-act). This builds the unbuilt "Approval that scales" design (P4 of the 2026-10-04 plan) instead of a second policy system. | 29 of 37 folders are trusted [V]; all 1,754 foreign MCP calls since 2026-10-06 were auto-approved [V]; ≥549 `ssh` calls from `/home/prod-ops` were auto-approved [V]. |
| 6 | Production stays **read-only for agents** in code, not only in prompts: read-only DB roles, a ClickHouse `readonly` user, a GET-only Docker API proxy, row caps and PII redaction. Acts use a separate key and a decision card. | Today "read-only" is a rule in two project `CLAUDE.md` files [V]; the deploy user has passwordless sudo [U]. |
| 7 | P0 fixes the verified gaps first (guard misses `~/.ssh/*_key`, name-keyed `mcp__neo__` allow, public DB ports, leaked MCP containers, non-constant-time bearer compare). | All verified in this session (§1.6). |
| 8 | Proactive work **extends what exists** (attention digest 08:00, secretary, waiting sweep, security/disk/error sweeps, the claude.ai `morning` skill, the email inbox). It adds a `node` attention producer and event triggers with untrusted payloads. No new brief. | Neo already reads email and has a morning digest and loops [V]. |
| 9 | Heavy builds, tests and CI runners move to a **build node**. Long jobs become engine-owned jobs that survive reloads. | Load 70.6 / 146.1 / 144.8 on 8 vCPUs, swap full [V]. Three CI runners run on this host [V]. |
| 10 | Delivery: P0 spike + hardening (3–4 d) → P1 gateway + prod read-only (6–8 d) → P2 connectors (3–5 d) → P3 build node + jobs (6–10 d) → P4 events + proactive (4–6 d) → P5 act with approval (3–5 d). About 25–38 engineer-days. 11 operator decisions (§12). | — |

---

## 1. What exists today (verified baseline)

### 1.1 Engine, firewall and governor

- **Customer firewall.** `route()` refuses any `source: "customer"` order, independent of config
  [V `src/engine/provider-router.ts:9-20`]. Customer-tainted briefs run with zero tools
  (`TAINTED_DISALLOWED_TOOLS`, no MCP) and auto-memory off [V `src/engine/ingress.ts:29-45`].
- **Governor.** `decide()` allows read-only built-ins (`SAFE_TOOLS`) and any tool whose name starts
  with `mcp__neo__` [V `src/engine/governor.ts:192-202, 233-234`]. Writes are path-fenced
  [V `governor.ts:236-251`]. `ssh`, `scp`, `curl`, `prod` and similar Bash words escalate
  [V `governor.ts:185-188`]. Everything else, including foreign MCP tools, escalates
  [V `governor.ts:261-262`].
- **Two hook points, one decision.** The same `decide()` runs as a PreToolUse hook and in
  `canUseTool` [V `src/engine/session-runner.ts:371-480`]. Workers start with
  `settingSources: ["user","project"]` and `permissionMode: "default"`
  [V `session-runner.ts:494, 507`].
- **Trust.** An escalation auto-approves when the folder is trusted, unless it is a fence escalation
  or customer work [V `session-runner.ts:417-423`]. 29 of 37 folders are trusted, including
  `/home/prod-ops`, `/home/eticket-prod`, `/home/tkt` and `/home/traefik` [V `data/trust.db`, read-only].
- **Measured effect.** From 2026-10-06 to 2026-10-27 06:43 UTC the ledger holds 61,771 governed tool
  calls: 48,562 allowed, 13,197 auto-approved by trust, 8 escalated, 4 denied [V `tool_actions`].
  All 1,754 calls to MCP tools other than `mcp__neo__*` were auto-approved [V]. In practice
  "default-escalate" is "default-allow" in a trusted folder.

### 1.2 How workers reach tools today

- **In-process `neo` server** for every operator worker, plus three attached servers
  [V `src/engine/dispatch.ts:2018-2039`]:
  - `stitch`: a **remote HTTP MCP server** with an API-key header, the precedent for remote MCP
    [V `dispatch.ts:2020-2024`, `STITCH_MCP_URL` at `dispatch.ts:1556`].
  - `codebase-memory` (stdio) and `playwright` (stdio) [V `dispatch.ts:2025-2038`].
- **Project `.mcp.json` servers** load through `settingSources: "project"` [V `session-runner.ts:494`].
  eticket-v3 starts `docker run -i --rm` containers per session for postgres, mongodb, redis,
  clickhouse and temporal [V `/home/eticket-v3/.mcp.json`, shape read with values redacted].
- **claude.ai hosted connectors** (Gmail, Google Calendar, Drive, Docs, Sheets, Slides, Claude
  Docs) are in the tool list of the company worker that wrote this plan [V this session's tools;
  `mcp__neo__dispatch` is present, which only the company gets, `pipeline.ts:645`]. The SDK loads
  claude.ai connectors unless `strictMcpConfig` is set [D TypeScript reference]. Neo sets it nowhere
  [V `grep` of `src/`].
- **API keys in the engine.** The `tool_api` relay calls an `api` card's operation with a key only
  the engine holds, caps calls per project per day, and records each call without bodies
  [V `src/engine/tools-catalogue.ts:380-423`; ADR-0044]. It is off by default
  (`relayEnabled: false`, [V `tools-catalogue.ts:92`]).
- **Gaps already named in ADRs:** loops get no Neo MCP server (ADR-0004), and Codex runs get no Neo
  MCP servers (ADR-0044 consequences) [V].

### 1.3 Email and the morning brief already exist

Neo **already reads email** [V]:
- **Customer mail:** Cloudflare Email Routing → Worker → `neo-gateway` container → `POST /inbox`
  (bearer) → `data/inbox.db` → Telegram `/inbox` and the console; a reply leaves only after the
  operator approves it [V `gateway/DEPLOY.md`, `src/frontends/web.ts:167-189`,
  `src/engine/inbox.ts:1-4`; `neo-gateway` is running, `docker ps`]. The inbox holds 0 rows today [V
  count only]. WhatsApp goes to a Gemini front desk that hands off to the same inbox [U memory note
  `whatsapp-voice-frontdesk-triage`].
- **Operator mail:** the claude.ai Gmail connector is loaded into Neo's Claude workers [V].

Neo **already has a morning loop and brief**, and more proactive surfaces [V]:
- The **attention digest** at `attention.digestAt`, default `0 8 * * *`
  [V `src/engine/producers/engine.ts:42`, `src/engine/attention-actions.ts:278-283`,
  `src/daemon.ts:519`].
- The **secretary** loop: a decisions digest every 2 h, 08:00–22:00, enabled on the live ledger
  [V `src/engine/loops.ts:276-296`; `loop_state` row `secretary enabled=1`].
- **`mywellbeing-checkin`**: a 06:00 morning check-in, off by default [V `loops.ts:192-209`].
- The claude.ai **`morning` skill** (calendar + email + chat → one HTML brief; supports a
  `Sections:` list) is synced into `~/.claude/skills/synced/…/morning/SKILL.md` and so reaches
  workers [V file].
- **Loops on the ledger:** `waiting-sweep` (hourly reminder), `security-sweep` (03:00),
  `disk-cleanup` (hourly), `waselni-store-readiness` (06:00); built-ins `error-sweep` and
  `docs-sweep` are enabled [V `loop_defs`, `loop_state`].

Which of these the operator calls "the morning brief" is [U]. This plan extends all of them (§6) and
adds no new brief.

### 1.4 Servers and how they are reached today

| Server | Facts | How Neo reaches it today |
|---|---|---|
| **This dev host** | Hostname `dev.tgate.cloud`, public IP 72.60.188.160, `srv1932738.hstgr.cloud` [V]. Traefik on 0.0.0.0:80/443 with a Cloudflare DNS-01 resolver and a CrowdSec plugin [V `docker inspect traefik`]. Neo console on 172.20.0.1:3003 behind Traefik [V `ss`]. Shared browser on 127.0.0.1:9222 [V]. | Local. Workers run here as root [V systemd unit `User=root`]. |
| **eticket prod** `srv1936828.hstgr.cloud` | Resolves to 72.62.30.5 [V DNS]. Runs Coolify; hosts eticket-v3 (app + infra) and waselni; Cloudflare edge [V `/home/prod-ops/CLAUDE.md`; live state U]. Port 443 open only to Cloudflare IPs [U memory]. | `ssh -i /root/.ssh/prod_server_key deploy@72.62.30.5 '<cmd>'` from Bash [V `/home/prod-ops/CLAUDE.md`, `/home/eticket-prod/CLAUDE.md`]. |
| **"tgate"** | The docs call the prod box `cloud.tgate.cloud` and this host `dev.tgate.cloud` [V `/home/prod-ops/CLAUDE.md`]. `cloud.tgate.cloud` has no public A record and resolves to 127.0.0.1 here [V DNS-over-HTTPS, `getent`]. So "tgate" and srv1936828 look like **the same prod box** [U] → decision D6. | as above |
| **Coolify** | Dashboard `coolify.tgate.cloud` behind Cloudflare [V DNS]. Version [U]. | Project `.env` files hold `COOLIFY_TOKEN` / `COOLIFY_DEPLOY_TOKEN` names [V `docs/research/2026-10-22-tools-inventory.md`]. |
| **Other boxes** | Key files `backup_server_key`, `migrate_key`, `oldserver_key`, `contantme_deploy_ed25519` exist in `/root/.ssh` [V names only]. Their hosts are [U]. | Unknown. |

### 1.5 Load and resources on this host

- 8 vCPUs, 31 GB RAM [V `nproc`, `free`]. Load 70.6 / 146.1 / 144.8 at 06:08 UTC and 62.6 / 70.7 /
  89.8 at 06:32 UTC [V `uptime`]. Run queue 22–36, swap about 16 GB used (full), steal 3–8 %
  [V `vmstat`].
- Top CPU at 06:32: `eticket-connect-gateway` 65 %, `netdata` 53 %, `adminli-tenant` 29 %, a test
  Postgres 29 %, `eticket-clickhouse` 20 % [V `docker stats`]. Processes: `pnpm install`,
  `flutter analyze`, Playwright Chromium, two `codebase-memory-mcp` at 1.3–1.6 GB RSS, smoke tests
  [V `ps`].
- CI runners on this host: `wasilni-runner-1`, `wasilni-runner-2`, `contantme-runner-1` [V].
- **Leaked MCP containers:** 109 `crystaldba/postgres-mcp` containers are up (oldest 46 h), about
  1.36 GB RAM in total [V `docker stats`]. Source: the per-session `docker run -i --rm` servers in
  eticket-v3's `.mcp.json` [V]; a container stays up when its stdio client dies uncleanly [U cause].

### 1.6 Security gaps found while researching (all verified)

| ID | Gap | Evidence |
|---|---|---|
| G1 | Prod access is approved by trust, not by the operator. "Read-only unless approved" is prompt text. | ≥549 `ssh`/`scp` Bash calls auto-approved from `/home/prod-ops`, 124 from eticket-v3, 23 contantme, 19 waselni, 13 company [V `tool_actions`]; rules in `/home/prod-ops/CLAUDE.md` "Hard rules" [V]. |
| G2 | The ledger cannot say what ran on prod. | A tool label is cut at 60 characters [V `session-runner.ts:85, 98-102`]; all 474 `Bash: ssh …` labels from prod-ops and eticket-prod are truncated (64 characters at most), so the remote command is not recorded [V]. |
| G3 | The secret guard does not treat most SSH private keys as secrets. | `isSecretName()` returns false for `/root/.ssh/prod_server_key`, `backup_server_key`, `migrate_key`, `contantme_deploy_ed25519`; true only for `id_ed25519` [V ran the exported function; patterns at `tools/security/guard.ts:31-51`]. |
| G4 | A remote MCP header given to a worker is world-readable. | Worker `claude` processes (children of the daemon) carry `--mcp-config` on their command line, including the Stitch `X-Goog-Api-Key` header [V `/proc/<pid>/cmdline`, value not printed]; `/proc` is mounted without `hidepid` [V `mount`]. |
| G5 | Neo's own tools are trusted by name. | `tool.startsWith("mcp__neo__")` → allow [V `governor.ts:233-234`]. The SDK says to key trust on `mcpServer.source`, "not on the name or the tool-name prefix" [V `sdk.d.ts:245-259`]. A project `.mcp.json` server named `neo` would be allowed [U, test in P0.4]. |
| G6 | Outbound connector actions are auto-approved in trusted folders. | Gmail `send_message`/`forward`/`reply`/`trash_*`, Calendar `create_event`/`delete_event`, Drive `share_file`/`trash_file` are loaded [V]; they fall to default-escalate and trust auto-approves them [V `governor.ts:261`, `session-runner.ts:419`]. No call was recorded yet [V `tool_actions`]. |
| G7 | Database ports are open on all interfaces of a public host. | `adminli-ai-postgres` 0.0.0.0:5433 and `adminli-ai-qdrant` 0.0.0.0:6333-6334 [V `ss`, `docker ps`]; `firewalld` inactive and not installed [V]; provider firewall [U, memory says none]. |
| G8 | Machine-to-machine bearer check is not constant-time; one secret serves two endpoints. | `auth !== \`Bearer ${…}\`` for `/agent/ingress` and `/inbox` [V `web.ts:151, 171`]. |
| G9 | Leaked MCP containers waste RAM on a host whose swap is full. | §1.5 [V]. |

---

## 2. Infinity: what it is, how mature it is, and where it fits

Source: read-only clone of `github.com/hydro-project/infinity` at commit `341f6c2` (2026-10-23) in
an empty `/tmp` folder. Nothing was built or run [V].

### 2.1 What it is

- **Infinity Runtime** (`infinity-agent-core`): a Rust library that runs each agent as short
  "execution slices". Between slices an agent is only stored history, so it "hibernates for free"
  [V `README.md`, `docs/docs/infinity-runtime/overview.md`]. Claim: 75k agents in a Raspberry Pi's
  memory; measured 50,000 agents at about 154 KB each [V `crates/infinity-agent-core/CHANGELOG.md`].
- **RAP (Reactive Agent Protocol):** HTTP tool calls are fire-and-forget. The tool answers HTTP 200
  at once and later POSTs a `tool_result` to the runtime's `callback_url`. Other callback types:
  `subscription_event`, `oauth`, `user_choice`, `view_update`. Tools publish a toolset at
  `/.well-known/rap-toolset`; runtimes send best-effort `/cancel_tool_call` and `/close_thread`
  [V `docs/docs/rap/spec/overview.md`, `…/basic/transport.md`, `…/basic/lifecycle.md`].
  Subscriptions MUST be stored durably by the tool; the runtime injects each event as a synthetic
  tool call; `final: true` ends a subscription [V `…/server/subscription-events.md`]. `user_choice`
  lets a tool ask the user to pick an option before it acts [V `…/server/user-choice.md`].
- **MCP compatibility layer:** a proxy turns an MCP server into a RAP tool with two wrapper tools,
  `{name}_list_tools` and `{name}_invoke_tool`. The Lambda proxy opens a fresh MCP session per call
  [V `docs/docs/rap/about/mcp-compatibility.md`]. It wraps MCP **for RAP runtimes**; it does not help
  an MCP client such as a Claude worker.
- **Deployment:** local (the Infinity Code daemon embeds the runtime) or AWS Lambda with Aurora DSQL,
  SQS FIFO, EventBridge and Bedrock, SigV4 between Lambdas
  [V `docs/docs/infinity-runtime/serverless/architecture.mdx`, `…/serverless/rap-mcp-servers.md`].
- **Infinity Code:** a coding agent on the runtime, with RAP servers `sandbox-local` (bwrap
  sandboxes, `execute_command`), `rap-steering-server`, `rap-github-event-poller`, and SSH "remotes"
  that tunnel to another machine's daemon socket [V `docs/docs/infinity-code/*.md`].

### 2.2 Maturity

| Fact | Value |
|---|---|
| History | 512 commits, 2025-11-19 → 2026-10-23 [V `git log`] |
| Releases | v0.1.0 on 2026-09-03, v0.2.0 on 2026-10-22, all crates in lockstep [V tags; `RELEASING.md`] |
| People | About 430 commits by one author, 60 by a second, a few by others [V `git shortlog`] |
| GitHub | 99 stars, 15 forks, 55 open issues + PRs, repo created on GitHub 2026-04-13, Apache-2.0 [V `gh api`] |
| Size | About 57k lines of Rust, 219 test functions, CI and release workflows [V] |
| Open issues that matter to Neo | #101 "rename `group_id` to `thread_id`" (a breaking wire change, planned); #45 "active subscriptions are left behind on ungraceful shutdown"; #131 "stopping an agent does not actually stop the agent"; #93 "all sessions disappear after dirty reboot"; #98 "silent infinite retry loop … 120s stream-stall watchdog"; draft PR #154 "let RAP servers inject system-prompt fragments via their manifest" [V `gh issue list`, `gh pr list`] |

### 2.3 Hard constraints against Neo

| Constraint | Infinity fact | Consequence |
|---|---|---|
| Subscription, no API key (settled) | All inference goes through `ModelProvider`; the shipped provider is Bedrock; the optional `rig` bridge uses API-key backends [V `docs/docs/infinity-runtime/model-providers.md`]. Infinity Code "refuses to start without" a provider [V `docs/docs/infinity-code/model-providers.md`]. | The runtime, Infinity Code and Lambda cannot be Neo's brain. |
| The governor lives in code (`canUseTool` + hook) | A RAP runtime dispatches tools itself; the only approval hook is a tool-initiated `user_choice` [V]. | A RAP runtime would bypass ADR-0006/0011/0012. |
| Public host: bind loopback or authenticate | `sandbox-local` and `rap-github-event-poller` bind `0.0.0.0` [V `crates/sandbox-local/src/server.rs:24-25`, `crates/rap-github-event-poller/src/main.rs:170-171`]. No inbound auth in `rap-protocol`/`rap-client`; SigV4 only in the Lambda sandbox [V `grep`; `crates/sandbox-remote/src/sigv4_client.rs`]. The local callback server binds 127.0.0.1 with no token [V `crates/rap-client/src/callback_server.rs:14-20`]. The spec leaves auth "implementation-specific" [V `…/basic/transport.md`]. | Reference RAP servers cannot run here as shipped. Neo must add auth itself. |
| Durability | The GitHub poller keeps subscriptions in an in-memory `HashMap` [V `crates/rap-github-event-poller/src/lib.rs:59-79`], against the spec's MUST. | Do not reuse the poller. Neo already scans GitHub every 30 min [V `docs/CONFIG.md` `github.scanEveryMs`]. |
| Everything in Docker, Hostinger + Coolify | Cloud path is AWS-only [V]. | No Lambda. |

### 2.4 What the Claude Agent SDK supports for remote MCP (verified)

- Transports: `stdio`, `http` (Streamable HTTP), `sse`, and in-process `sdk` servers
  [V `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1205-1220, 1248, 1353-1360`; D agent-sdk/mcp].
- Auth: `headers` on `http`/`sse` (for example `Authorization: Bearer …`); the SDK runs no
  interactive OAuth flow; a server without usable credentials reports `needs-auth` [D agent-sdk/mcp].
- Per-server `timeout` is "a hard wall-clock limit per call; progress notifications do not extend it"
  [V `sdk.d.ts:1211-1213`]; the default `MCP_TOOL_TIMEOUT` is about 28 hours [D code.claude.com/docs/en/mcp].
- Per-tool policy for remote servers: `tools: [{ name, permission_policy: always_allow|always_ask|always_deny }]`
  [V `sdk.d.ts:1324-1333`].
- Provenance: `canUseTool` gets `mcpServer: { name, source }`; `source: "sdk"` only for host-registered
  in-process servers [V `sdk.d.ts:245-259`]; the PreToolUse hook input has `mcp_server`
  [V `sdk.d.ts:2804-2810`].
- Session control: `setMcpServers`, `mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer`
  [V `sdk.d.ts:3283`; D TypeScript reference]; `strictMcpConfig` ignores project, user, plugin and
  claude.ai servers [D TypeScript reference].
- **Long calls:** "An MCP tool call … still running after two minutes moves to a background task …
  the result arrives as a task notification"; MCP Tasks are "in public beta" from Claude Code
  2.1.304; `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` sets or disables the threshold
  [D code.claude.com/docs/en/mcp]. The installed SDK bundles Claude Code 2.1.310
  [V `package.json` `claudeCodeVersion`, `manifest.json`]; the running daemon booted with SDK
  0.3.310 on 2026-10-27 03:51 UTC [V `engine_boots`]. A backgrounded task found orphaned after a
  worker restart ends `stopped` with `reason: "worker_restart"` [V `sdk.d.ts:6288-6292`].
- MCP **Tasks** is an MCP extension (`io.modelcontextprotocol/tasks`): durable task id, `tasks/get`
  polling, `input_required` for mid-flight user input, `tasks/cancel`
  [D modelcontextprotocol.io/extensions/tasks/overview; spec 2025-11-25 changelog item 9].
- Streamable HTTP servers MUST validate `Origin` and SHOULD bind 127.0.0.1 locally and authenticate
  every connection [D spec 2025-11-25 transports].

### 2.5 Where each option fits (decision)

| Need | Choice | Why | Infinity role |
|---|---|---|---|
| Agent brain, sessions, hibernation | Neo + Claude Agent SDK (unchanged). Neo already idle-closes and resumes sessions [V `docs/HISTORY.md` Phase 2]. | §2.3 | **Rejected:** runtime, Infinity Code, Lambda |
| Synchronous reads/ops on own servers | MCP through the reach gateway: stdio-over-SSH (prod, build node), loopback (this host) | Native, governed, no new port, standard [D] | none |
| SaaS with a vendor MCP server | Vendor remote MCP through the gateway (Cloudflare API MCP, GitHub MCP), token held by the engine | Vendor-maintained; token stays out of worker cmdline (G4) | none |
| SaaS with only a REST API | `api` card + existing `tool_api` relay (ADR-0044) | Already built [V] | none |
| Google Workspace, other claude.ai connectors | claude.ai hosted connectors, governed by provenance class map | Already loaded; the same catalogue Duet uses [S] | none |
| **Long jobs** (remote builds, tests, exports) | Engine-owned job. Transport chosen in P0: engine-polled **MCP Tasks** vs **RAP job** with push callback | Must survive worker handoffs and daemon reloads | **Challenger** |
| **Node events** (container died, disk, deploy done) | Engine-owned subscription. Transport chosen in P0: engine **cursor polling over MCP** vs **RAP `subscription_event` push** vs **signed webhook** | Lifecycle (subscribe, cancel, final) and durability | **Primary candidate** |
| SaaS events (GitHub, Coolify, Cloudflare, sentinel) | Vendor-native signed webhooks, or the existing polling scans | Industry standard | none (`rap-github-event-poller` rejected, §2.3) |
| Tool-initiated approval mid-job | Always a Neo decision card. Transport: MCP Tasks `input_required` or RAP `user_choice` | Neo's governor already owns approve-before-act [V] | optional transport |

**Revisit Infinity when:** RAP reaches a frozen spec (after #101), reference servers ship inbound
auth and durable subscriptions, and a TypeScript client exists. Or if the operator ever accepts an
API-key/Bedrock path for a workload (not planned).

### 2.6 Head-to-head test (pre-registered, run in P0)

**Contenders**

| Code | Path |
|---|---|
| M1 | Synchronous MCP call through the gateway (stdio over SSH; loopback HTTP) |
| M2a | MCP long call owned by the worker: Claude Code auto-backgrounds it after 2 min |
| M2b | MCP Tasks owned by the engine: the gateway is the MCP client, stores the task id in the ledger and polls |
| R1 | RAP job: the node acks, then POSTs `tool_result` to the engine's callback endpoint (reverse SSH tunnel, HMAC) |
| P1e | Node events by engine cursor polling over MCP (`node_events(since)`) |
| R2 | Node events by RAP `subscription_event` push |
| H1 | Node events by signed webhook (HMAC-SHA256) |

**Workloads**

| ID | Load | Perturbations |
|---|---|---|
| W1 | 100 short reads (`docker ps`) | none |
| W2 | 6-minute job printing a line every 5 s | (a) none; (b) worker interrupted and resumed at min 2 (handoff analogue); (c) Neo daemon restarted at min 3; (d) node agent restarted at min 4; (e) operator cancel at min 1 |
| W3 | 60 node events in 30 min, with one burst of 20 in 10 s | Neo down for 3 min; one forged event; one replayed event |
| W4 | Node asks "restart container X?" mid-job | approve; deny; no answer (timeout) |
| W5 | Node unreachable for 10 min; credentials revoked | — |

W2 runs 3 times per perturbation per contender. The spike runs on this host's loopback plus one SSH
round trip to a non-prod box (D6/D3 decide which). Never prod in P0.

**Metrics:** results/events lost; duplicates after dedupe; forged messages accepted; false stall
aborts; time to result after a restart; worker tokens spent while waiting; progress visible to the
operator; cancel latency; ledger rows per call; p50/p95 latency; new daemons, languages and lines of
code.

**Rules, fixed before the run**

1. Hard gates for every contender: 0 forged messages accepted, 0 lost results, 0 false stall aborts.
2. **Long jobs:** M2a wins if it passes W2 (a)(b)(c)(e) in 3/3 runs. Otherwise the engine-owned path
   that passes all of W2 wins: M2b before R1 on a tie (MCP is the standard and the gateway already
   speaks it). R1 wins only if it passes a perturbation that M2b fails.
3. **Node events:** P1e wins unless push is needed. R2 wins over P1e only if delivery after Neo's
   3-minute outage is exactly-once-after-dedupe **and** the event-to-attention time is below 10 s
   where P1e needs its poll interval **and** R2 costs at most 2 engineer-days more. H1 is used for
   SaaS sources whatever the result.
4. **Approvals:** the Neo decision card is always the surface. RAP `user_choice` is used only if R1
   or R2 is adopted anyway.
5. The result goes into ADR-0056 with the measured numbers.

---

## 3. Target architecture

### 3.1 Picture

```
Operator ── Telegram / web console (existing) ──────────────────────────────────────────────┐
                                                                                             │
┌─ Neo engine (this host, systemd, no AI) ───────────────────────────────────────────────────┤
│ pipeline · dispatch · todo queue · loops/scheduler · attention · decisions · ledger         │
│ governor: PreToolUse hook + canUseTool (decide) ── action classes (read / act / prod-act)   │
│                                                                                             │
│ ┌─ reach gateway (NEW, in-process) ──────────────────────────────────────────────────────┐ │
│ │ node registry (config.json `reach`) · policy classes · credential vault (engine only)   │ │
│ │ sync:  MCP stdio over SSH (prod, build) · MCP loopback (this host) · vendor remote MCP │ │
│ │        (Cloudflare, GitHub) · tool_api relay (Coolify, Hostinger, healthchecks)         │ │
│ │ async: jobs + node events (transport per ADR-0056: MCP Tasks / cursor poll / RAP push)  │ │
│ │ ingress: POST /hooks/<source> (HMAC) for SaaS webhooks → events → attention / triggers  │ │
│ │ audit: one ledger row per call (node, tool, class, verdict, approver, hashes, status)   │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────┘ │
│ in-process MCP servers for workers: `neo`, `reach` (both source "sdk")                       │
└───────────────┬─────────────────────────────────────────────────────────────────────────────┘
                │ query({ cwd, hooks, canUseTool, mcpServers: { neo, reach, … } })
     Claude Agent SDK workers (the brain, subscription) ── claude.ai connectors (governed by class)

prod (srv1936828)              build node (NEW, P3)              this host
 node agent (Docker)            node agent + runners + BuildKit   node agent (loopback)
 read key: forced command,      job tools (checks, builds)        host stats, docker, reaper
 from=72.60.188.160             no production secrets
 act key: separate (P5)
 docker-socket-proxy GET only
 neo_ro DB roles, CH readonly
```

### 3.2 Components

| Component | What it is | Where |
|---|---|---|
| **Node** | A machine or service Neo may reach: `{ name, env: dev\|prod, transport, host, user, classes, projects }` | `config.json` → `reach.nodes` (no secrets) |
| **Node agent** | A small Bun MCP server in Docker on the node. It exposes only allow-listed tools. It is the final enforcement point. | `tools/reach-node/` kit (like `tools/browser`, `tools/disk`) |
| **Reach gateway** | Engine module: the MCP client to nodes and vendor servers, connection pool, timeouts, size caps, redaction, audit | `src/engine/reach-gateway.ts` |
| **`reach` tools** | In-process MCP server given to operator workers: `reach_nodes`, `reach_tools(node)`, `reach(node, tool, args)` | `src/engine/reach-tools.ts`, attached in `neoMcpServers` |
| **Action class** | `read`, `act`, `prod-act` per node tool (and per connector tool) | node manifest + `reach.connectorClasses` |
| **Credential vault** | Engine-only secrets: SSH keys, tokens. Never in worker env, briefs, logs or `--mcp-config`. | `.env` key names + `data/reach/` (0600, gitignored) |
| **Job** | An engine-owned long call with a ledger row; the worker is told "job #N started" | `src/engine/reach-jobs.ts` |
| **Node event** | An event from a node or SaaS source, stored, deduped, turned into attention or a loop trigger | `src/engine/reach-events.ts` |

This reuses ADR-0044's shape: `tool_api(card, operation, body)` becomes
`reach(node, tool, args)`. The relay stays for plain REST cards.

### 3.3 Flows

1. **Synchronous read.** Worker calls `reach(prod, docker_logs, {container, since, tail})` → hook +
   `canUseTool` → class `read`, project allowed → gateway opens or reuses the SSH stdio session →
   node agent checks its own allow-list → result is redacted, capped, returned → ledger row.
2. **Long job.** Worker calls `reach(build, run_checks, {repo, ref, profile})` → the tool returns
   "job #N started; the result comes back to this thread" → the engine marks the session
   `blockedOn: { kind: "job" }`, which pauses the stall clock (the same mechanism as questions,
   `dispatch.ts:1169`) → result arrives (MCP Tasks poll or RAP callback) → delivered with
   `followUp(…, "after-turn")` to a live session or `deliverIntoFolder` to a resumed one
   [V `pipeline.ts:396, 566`; `reply-routing.ts:107`] → the todo continues.
3. **Node event.** The node reports "container X restarted 3× in 10 min" → the engine stores it
   (dedupe on `(node, event id)`) → a `node` attention item (high goes to Decisions) → optional loop
   trigger with the payload marked untrusted.
4. **Act.** Worker calls `reach(prod, restart_container, {name})` → class `prod-act` → always a
   decision card (what, where, why, rollback) → operator approves → a single-use approval bound to
   the argument hash → the act key path → ledger row with the approver.

### 3.4 Server-by-server map

| Server / service | Path from Neo | Identity | Classes allowed | Phase |
|---|---|---|---|---|
| This host | Loopback MCP to a node agent bound to 127.0.0.1 | none (local) | read | P1 |
| eticket prod (srv1936828) | MCP stdio over SSH, forced command | ed25519 read key, `from="72.60.188.160"` | read; prod-act in P5 with a second key | P1, P5 |
| Coolify API | `tool_api` relay | Coolify API token, `read` (deploy token in P5); Coolify IP allow-list | read; act (deploy) | P2, P5 |
| Build node (new) | MCP stdio over SSH | runner key | read, run (jobs) | P3 |
| Cloudflare | Cloudflare API MCP `https://mcp.cloudflare.com/mcp` through the gateway | read-only API token (bearer) [D] | read; act in P5 | P2 |
| GitHub | existing `gh` scan + GitHub remote MCP in read-only mode | fine-grained PAT, read scopes | read; act (comment) in P5 | P2 |
| Google Workspace | claude.ai hosted connectors | operator's claude.ai sign-in | read; act asks | P2 |
| Telegram | existing bot | existing | — | — |
| Customers (email, WhatsApp) | gateway + Gemini only | gateway secrets | **never** reach or workers with tools | unchanged |
| Hostinger VPS API, healthchecks.io | `tool_api` relay | read tokens | read | P2 |
| Backup / old boxes | decide (D6) | — | — | later |

---

## 4. Security model (a dev host that is public)

### 4.1 Threats, in order

1. **A confused or prompt-injected worker** acts on prod or sends mail. Today trust lets it (G1, G6).
2. **Secret exposure on this host.** Workers run as root; `/proc` is readable (G4); the guard misses
   keys (G3).
3. **Inbound attack on the public host** (open DB ports G7, forged callbacks, forged webhooks).
4. **Untrusted text from nodes** (logs, emails, webhook payloads) steering a worker.
5. **Full compromise of this host.** Then every engine-held credential is lost. The design limits
   the damage at the node: read-only roles, forced commands, `from=` IP binding, a separate act key.

### 4.2 Network

- No new listening port on this host for the reach plane. The gateway connects **out** over SSH.
- Node agents bind 127.0.0.1 or run with no published port; the SSH forced command starts the agent
  in stdio mode (`docker exec -i reach-node node-agent --stdio`).
- If R1 or R2 wins (ADR-0056), callbacks use a **reverse SSH tunnel** opened by Neo
  (`ssh -R 127.0.0.1:<port>:127.0.0.1:<engine-port>`), so a node posts to its own loopback and the
  engine endpoint stays on 127.0.0.1.
- SaaS webhooks are the only new inbound traffic: one Traefik route `/hooks/<source>` with HMAC per
  source, per-source rate limits, and the existing CrowdSec bouncer [V Traefik args].
- Vendor MCP traffic is outbound HTTPS only.

### 4.3 Authentication

| Link | Mechanism |
|---|---|
| Neo → prod / build node | One ed25519 key per node per capability. `authorized_keys` options: `restrict,command="…",from="72.60.188.160"`. Host key pinned (`StrictHostKeyChecking=yes`, own `known_hosts`). |
| Neo → vendor MCP | Least-privilege token in `Authorization: Bearer`, held by the gateway, never passed to a worker. |
| Neo → Coolify | Coolify API token with only `read` (then `deploy`), team-bound, with Coolify's API IP allow-list [D coolify.io/docs/api/permissions]. Check the version first: CVE-2026-32718 let read-scoped tokens change state before 4.0.0-beta.466 [S]. |
| Node → Neo (only if RAP/webhook wins) | Per-node HMAC-SHA256 over body + timestamp; 5-minute window; dedupe on `(node, message id)`; the callback URL carries an opaque per-call token; constant-time compare. |
| SaaS → Neo webhooks | Vendor signature (GitHub `X-Hub-Signature-256`) or a per-source shared secret; constant-time compare. |
| HTTP nodes (if one is ever needed) | mTLS with a private CA held by the engine, plus a bearer. |

### 4.4 Authorization

- **Three layers, all must allow:** the node agent's own allow-list (authoritative), the gateway's
  node registry (which projects may call which node tools), the governor's class decision.
- **Classes.**
  - `read`: no state change. Trust may auto-approve. Allowed in loops that opt in.
  - `act`: a state change outside this host (send mail, comment, purge cache). Always a decision
    card. Trust never lifts it. Never in loops, consult runs, customer or tainted runs.
  - `prod-act`: any state change on a prod node. As `act`, plus a separate key and a single-use
    approval bound to the argument hash. A standing approval is not allowed (D5).
- **Read-only prod in code:**
  - Postgres: role `neo_ro` with `default_transaction_read_only = on`, `SELECT` on allow-listed
    schemas, `statement_timeout`, on the replica where one exists (`eticket-postgres-replica` [U]).
  - ClickHouse: a user with profile `readonly = 1` and `max_execution_time`.
  - Docker: through a socket proxy that allows GET only (for example `docker-socket-proxy` with
    `POST=0`); never the raw socket.
  - Logs: allow-listed containers, `--since` and `--tail` caps, secret and PII redaction
    (`src/engine/secret-patterns.ts` plus phone/email masks), a byte cap.
  - No shell tool on a prod node. No `sudo` from the agent.
- **Projects:** prod tools are scoped to `prod-ops`, `eticket-prod` and the company by default; a
  project can be added in config.

### 4.5 Governor integration

- `decide()` takes the SDK provenance. `mcp__neo__*` and `mcp__reach__*` are allowed only when
  `source === "sdk"` (fixes G5).
- A `reach(node, tool, args)` call is classified from the registry and the node manifest:
  `read` → allow (trusted folder) or escalate (untrusted folder); `act`/`prod-act` → a **pinned**
  escalation. `pinned` works like `fenced`: trust never auto-approves it
  [V the `fenced` rule at `session-runner.ts:419`].
- Connector tools from `source: "claudeai"` are classified by `reach.connectorClasses`
  (glob → class). The defaults are in §5.
- **Host fence for raw SSH:** a Bash command that runs `ssh`, `scp`, `rsync` or `sftp` against a
  registered node host or IP is a pinned escalation. The worker is told to use `reach`. This closes
  G1 without breaking SSH to other hosts.
- Loops: a `LoopDef.reach` list (for example `["prod:read"]`) opts a loop into read tools only. This
  amends ADR-0004.
- Codex workers get no `reach` (no in-process MCP on Codex, ADR-0044 gap). Unchanged.

### 4.6 Secrets

- Engine `.env` holds key **names** and token values (`chmod 600`); SSH keys live in
  `data/reach/keys/` (0600, under gitignored `data/`).
- The worker env scrub drops every reach key name, like relay keys today (ADR-0050 §7).
- Never put a reach secret in `mcpServers.headers`: the gateway holds it (G4). Move the existing
  Stitch key behind the gateway too (P2).
- The guard learns that every private key file under `~/.ssh/` and `data/reach/keys/` is a secret
  (fixes G3).
- Rotation: one documented command per credential. A rotated or revoked credential gives a `node`
  attention item, not a silent failure.

### 4.7 Audit in the ledger

One row per reach call (an extension of `tool_actions`, or a `reach_calls` table if the columns do not
fit): node, tool, class, project, order id, thread id, verdict (`allow` / `auto` / `escalate` /
`deny`), approver and time, an argument hash plus a redacted 200-character summary (never the full
body), bytes in and out, status, latency. It shows in `/trace` and `/events`. Retention uses the
existing `toolActionsKeep`. This closes G2.

### 4.8 Customer firewall

Unchanged. `reach` is never attached on the customer, ingress or tainted paths, the same as
`ask_operator` and `tool_api` today [V `ingress.ts:88-107`].

### 4.9 Production data on a dev host

CLAUDE.md: "Never copy real production or customer data here without the operator's approval" [V].
A reach read puts prod rows into a worker transcript on this host. Default: aggregate queries and
redacted rows; raw rows only through an `act`-class `prod_query_raw` tool that asks every time (D4).

---

## 5. Connector catalogue (prioritised)

| Pri | Connector | Transport | Read tools (auto in trusted folders) | Act tools (always ask) | Phase |
|---|---|---|---|---|---|
| 1 | **prod node** (srv1936828) | MCP stdio over SSH | `containers` (ps), `container_inspect` (env redacted), `logs`, `host_stats` (load, mem, disk), `pg_query_ro`, `ch_query_ro`, `coolify_status` | `restart_container` (allow-listed names), `coolify_redeploy` (P5) | P1, P5 |
| 2 | **this host node** | loopback MCP | `host_stats`, `containers`, `leaked_mcp_containers`, `top_consumers` | — (reaping goes through the disk kit) | P1 |
| 3 | **claude.ai Google connectors** | hosted (already loaded) | `search_*`, `list_*`, `get_*`, `read_*`, `download_*` | Gmail `send_message`, `reply`, `forward`, `trash_*`, `create_draft` (ask once per draft); Calendar `create_event`, `update_event`, `delete_event`, `respond_to_event`; Drive `share_file`, `trash_file`, `update_file`, `create_file`; Docs/Sheets/Slides `update_*`, `append_*` | P2 |
| 4 | **GitHub** | GitHub remote MCP, read-only (`X-MCP-Readonly: true` or `/x/all/readonly` [S, check in P2]) + existing `gh` scan | PRs, issues, Actions runs and logs | comment, label, re-run CI (P5) | P2 |
| 5 | **Cloudflare** | Cloudflare API MCP (`search()`, `execute()`, `docs()`) with a read-only token [D] | DNS, zone analytics, certificates, Workers status | cache purge, DNS change (P5) | P2 |
| 6 | **Coolify** | `api` cards via `tool_api` | applications, deployments, status, logs (`read`; `read:sensitive` never by default) | deploy, restart (deploy token, P5) | P2 |
| 7 | **build node** | MCP stdio over SSH + jobs | `job_status`, `job_log` | `run_checks`, `build_image` (class `run`: no outside effect, budget-capped) | P3 |
| 8 | **sentinel** (uptime) | its existing `ALERT_WEBHOOK_URL` → `/hooks/sentinel` [V env name] | events only | — | P4 |
| 9 | Hostinger VPS API, healthchecks.io (read key) | `api` cards | VPS status, firewall rules, check status | — | P2 |
| 10 | Backups (pgBackRest/S3) | prod node tool | `backup_age`, `last_backup_status` | — | P4 |
| — | WhatsApp / customer email | gateway + Gemini only | — | — | never in reach |

Breadth beyond this list comes from the claude.ai connector catalogue the operator enables, with the
same class map. Neo does not build connectors the catalogue already has.

---

## 6. Proactive behaviour: extend the existing loops and brief

| Existing surface [V] | Extension | Engine or worker |
|---|---|---|
| Attention digest 08:00 | A new `node` producer adds items: prod container restarts, disk ≥ 85 %, cert expiry < 14 days, backup older than 26 h, CI failures, unreachable nodes. They appear in the same digest; high items go to Decisions. | Engine producer, deterministic (like `probe.ts`) |
| Secretary (2-hourly) | Unchanged. `act` approvals are decisions, so they appear in its digest. | — |
| Waiting sweep (hourly) | Unchanged. Its keep patterns already protect prod, deploy, DNS and secrets (`decisionSettle.keepPatterns`) [V CONFIG.md]. | — |
| `morning` skill (claude.ai) | Add a `Servers` section fed by a `reach_summary` read tool (one line per node: health, last deploy, open alerts). | Worker |
| `security-sweep` 03:00 | Opt in to `prod:read`: sshd config drift, listening ports seen from the node, fail2ban state. Report only. | Worker, read class |
| `error-sweep` 03:30 | Opt in to `prod:read` logs. Findings go as project notes to the owning project (ADR-0043), never fixes on prod. | Worker, read class |
| `disk-cleanup` hourly | Tier A adds leaked stdio MCP containers whose client process is gone (exact match, never broad). | Kit, deterministic |
| Loops in general | A new trigger kind `event` (deferred in `docs/loops.md` [V lines 14-15]) fires a loop on `(source, kind)`. The payload goes under `## Event (untrusted)`; the run is background class, held by the interactive reserve. This follows the unbuilt P5.1 design of the 2026-10-04 plan. | Engine trigger + worker |

The "check every few hours" behaviour of Duet [S] is the `node` producer on its own interval
(`reach.healthEveryMs`), with no model call when nothing changed.

---

## 7. Offloading heavy builds and tests

1. **Move the CI runners** (`wasilni-runner-*`, `contantme-runner-1`) to a build node. GitHub
   Actions on self-hosted runners is already the operator's CI model [U memory note
   `new-prod-server-tgate`]. No Neo code.
2. **Remote image builds:** a `docker context` (SSH) or BuildKit remote builder on the build node.
   A tool card recipe tells workers how. No Neo code.
3. **Test and check jobs:** `run_checks(repo, ref, profile)` on the build node agent runs the
   project's checks in a container for a pushed ref and returns the summary, a log tail and an
   artifact path. It is an engine-owned job (§3.3 flow 2), so a reload or handoff does not lose it.
4. **This host, meanwhile:** fix the leaked MCP containers (G9); run eticket-v3's data MCP servers as
   shared long-lived containers on 127.0.0.1 instead of one per session (dispatch to eticket-v3);
   a `host` attention item when load stays above 4× vCPU or swap is full for 15 min.
5. **Preamble:** one sentence (under 200 characters) tells workers to send heavy builds and test
   suites to `reach` jobs. The preamble is 4,322 characters [V measured] against a 5,000-character
   test ceiling [V `tests/dispatch.test.ts:1335-1337`].

---

## 8. Failure modes

| Failure | Detection | Behaviour | Recovery |
|---|---|---|---|
| Node unreachable | SSH connect error, MCP status | Tool returns a clear error; no retry of an act | `node` attention item; auto-reconnect with backoff |
| Node agent crash mid-job | job heartbeat stops | job `lost` after the timeout | attention item; worker told; re-run is the worker's choice |
| Neo reload during a job | boot finds `running` jobs | engine-owned job keeps its id | resume polling or accept the callback; deliver to the thread |
| Worker handoff during a job | session replaced | result goes to the thread, not the process | continuation session receives it |
| Duplicate result or event | dedupe key in the ledger | second copy dropped | — |
| Forged callback or webhook | HMAC fails | 401, ledger event | rate limit, alert after N |
| Event storm | rate per `(node, kind)` | coalesced into one attention item per window | — |
| Prompt injection in logs or mail | content is tool output | treated as data; acts still need a card; no exfil tool without a card | — |
| Credential revoked or expired | 401/permission denied | `node` attention item | rotation command |
| Vendor MCP down | MCP status `failed` [D] | tools missing; worker told | SDK reconnects in the background [D] |
| Infinity/RAP breaking change (#101) | contract tests | pinned spec version | adapter seam; fall back to MCP |
| SDK MCP Tasks beta changes | toolchain updater tests (ADR-0009) | SDK bump held if red | pin |
| Budget drain by event-triggered loops | meter | background class, reserve | `heldByReserve` [V `src/engine/budget.ts:87`] |

---

## 9. Phased delivery

## Global Constraints

- TDD: the failing test first, per acceptance criterion. `bunx tsc --noEmit` clean and `bun test`
  green before a task is done. One commit per task on a branch per phase
  (`feat/reach-p<N>-<slug>`), merged to `dev` (ADR-0054: done means live).
- No AI in the engine. The gateway, producers, classifiers and job tracking are deterministic.
- Default off: `reach.enabled` is `false`; an unconfigured daemon behaves exactly as today. Prod
  nodes have a class ceiling of `read` until `prod-act` is set explicitly.
- No hardcoding: hosts, users, ports, classes, caps and intervals live in `config.json`
  (`src/config.ts` readers with defaults) and `docs/CONFIG.md`; secrets in `.env` / `data/reach/`.
- Everything new on a node runs in Docker. Images are pinned by digest (as `tools/browser` does).
- New console strings go into the AR + EN catalogues; numbers, hosts and refs stay LTR.
- Never restart, merge to `master`, touch prod, or load a loop without the operator. **[OPERATOR]**
  marks those steps.
- A worker never edits another project from here: changes in eticket-v3, adminli, prod-ops or
  eticket-prod are dispatched to those projects.
- Docs in the same commit as the behaviour: `docs/CONFIG.md`, `docs/HISTORY.md`, `CONTEXT.md`, ADRs,
  `docs/tools/` cards.

## Review Focus

1. A trusted folder must never auto-approve an `act` or `prod-act` call. Pinned in P1.2 and P2.1.
2. No reach secret may appear in a worker's env, `--mcp-config`, brief, log or ledger. Pinned in P1.3.
3. The node agent must refuse what its own allow-list does not list, even if Neo asks. Pinned in P1.6.
4. A job result must reach its thread after a reload or a handoff, exactly once. Pinned in P3.3.
5. Event payload text must never be read as an instruction. Pinned in P4.3.

### P0 — spike and hardening (3–4 days)

#### Task P0.1: Reach spike harness (throwaway)

**Files:** create `spike/reach/` (`node-mcp.ts`, `node-rap.ts`, `runtime-rap.ts`, `webhook.ts`,
`run.ts`), following `spike/governor-bypass-probe.ts`. Output:
`docs/investigations/<date>-reach-spike.md`.

- [ ] Build a test node with tools `echo`, `long_job(seconds, lineEveryMs)`, `emit_events(n, burst)`
      and `needs_approval(action)`, served as MCP (stdio and Streamable HTTP on 127.0.0.1, MCP Tasks
      where the library supports it [U]) and as RAP (toolset, invoke, cancel, close, HMAC callbacks,
      SQLite job store).
- [ ] Run §2.6 W1–W5 for every contender with real SDK 0.3.310 workers. Cap: 2 worker-hours on the
      meter.
- [ ] Record every metric and apply the rules of §2.6 without changing them.

#### Task P0.2: SDK facts the design depends on

- [ ] In a dispatched worker: print `system/init` `mcp_servers` (are claude.ai connectors present,
      with which `scope`?).
- [ ] In `canUseTool` and the hook: log `mcpServer.source` for an sdk, a project and a claudeai tool.
- [ ] Long MCP call: does auto-backgrounding happen under the SDK? Which SDK messages arrive
      (`task_started`, `task_progress`, `task_notification`, `tool_progress`)? Do they keep Neo's
      stall clock alive? What happens on `interrupt()` + resume?
- [ ] Write the answers into the spike report; turn each [U] in §2.4 into [V] or a correction.

#### Task P0.3: The guard treats SSH private keys as secrets

**Files:** `tools/security/guard.ts`, `tests/security-guard.test.ts`.

- [x] Failing tests: `isSecretName("/root/.ssh/prod_server_key")` is `true`; the same for
      `backup_server_key`, `migrate_key`, `contantme_deploy_ed25519`, any file in
      `data/reach/keys/`; `*.pub`, `known_hosts`, `config` and `authorized_keys` stay `false`.
- [x] Implement: a path inside a `.ssh` folder or `data/reach/keys/` is a secret unless it is one of
      the public files.
- [ ] **[OPERATOR]** re-install the kit (`bun tools/security/install.ts`) so the live guard gets it.

#### Task P0.4: Neo's own tools are trusted by provenance

**Files:** `src/engine/governor.ts`, `src/engine/session-runner.ts`, `tests/governor.test.ts`,
`tests/governor-hook.test.ts`.

- [x] Failing tests: `mcp__neo__send_file` with `source: "project"` escalates; with `source: "sdk"`
      it is allowed; a missing source (an older CLI) keeps today's behaviour and records an event.
- [x] Implement: `GovernorCtx` gains `mcpSource`; `buildCanUseTool` passes `options.mcpServer`;
      the hook passes `input.mcp_server`.

#### Task P0.5: Constant-time machine bearer, one secret per endpoint

**Files:** `src/frontends/web.ts`, `src/config.ts`, `tests/web.test.ts`, `docs/CONFIG.md`.

- [x] Failing tests: a wrong bearer of equal length is refused through a constant-time compare; a
      separate `INBOX_INGEST_SECRET` (falls back to `AGENT_INGRESS_SECRET`) guards `/inbox`.
- [x] Implement with `crypto.timingSafeEqual` on equal-length buffers.

#### Task P0.6: Host hygiene (dispatches, no Neo code)

- [ ] Dispatch to adminli: bind `adminli-ai-postgres` and `adminli-ai-qdrant` to 127.0.0.1 (G7).
- [ ] Dispatch to eticket-v3: run its data MCP servers as shared long-lived Streamable-HTTP
      containers on 127.0.0.1 instead of `docker run -i --rm` per session (G9).
- [ ] **[OPERATOR]** decide the provider firewall for this host (D10).

#### Task P0.7: Design step

- [ ] `CONTEXT.md`: Node, Node agent, Reach gateway, Reach tool, Action class, Pinned escalation,
      Node credential, Job, Node event.
- [ ] ADR-0055 "Workers reach other servers only through the engine's reach gateway; trust lifts
      only reads". ADR-0056 "The async plane's transport is chosen by measurement" with the P0
      numbers. Amend ADR-0004 (loops may opt into read tools) and ADR-0044 (the relay pattern
      extends to nodes).

**P0 acceptance:** the spike report exists with every metric and a decision per row of §2.6;
P0.3–P0.5 are green on `dev`; the two dispatches are queued.

### P1 — reach gateway and the prod read-only node (6–8 days)

#### Task P1.1: `reach` config and validation

**Files:** `src/engine/reach-config.ts`, `src/config.ts`, `tests/reach-config.test.ts`,
`config.example.json`, `docs/CONFIG.md`.

- [ ] Failing tests: default `{ enabled: false, nodes: [] }`; a node with `env: "prod"` and no
      explicit `prod-act` has ceiling `read`; an unknown transport, a secret-looking value, or a
      host outside `allowedHosts` is rejected with a reason; a bad field keeps its default.
- [ ] Implement the reader with the existing env → file → default precedence.

#### Task P1.2: Action classes in the governor

**Files:** `src/engine/policy.ts` (the minimal P4.1 matcher of the 2026-10-04 plan),
`src/engine/governor.ts`, `src/engine/session-runner.ts`, `src/types.ts`,
`tests/governor-reach.test.ts`.

- [ ] Failing tests: in a trusted folder, `reach` `read` → allow; `act` → escalation that trust does
      **not** auto-approve; `prod-act` → the same; customer source → deny; consult → no tool.
- [ ] Implement `Verdict.pinned`; `buildCanUseTool` treats `pinned` like `fenced`
      (`session-runner.ts:419`).
- [ ] Failing test then fix: Bash `ssh`/`scp`/`rsync`/`sftp` to a registered node host or IP →
      pinned escalation naming `reach`; to an unregistered host → today's rule.

#### Task P1.3: Credential vault and env scrub

**Files:** `src/engine/reach-vault.ts`, `src/engine/worker-env.ts`, `tests/reach-vault.test.ts`,
`tests/worker-env.test.ts`.

- [ ] Failing tests: reach key names are removed from every worker env; the built SDK options for a
      worker contain no reach secret anywhere (walk the object); a missing key disables that node
      with a reason.
- [ ] Implement: secrets read from `.env` / `data/reach/` at daemon start; nothing written to logs.

#### Task P1.4: Gateway core

**Files:** `src/engine/reach-gateway.ts`, `tests/reach-gateway.test.ts`.

- [ ] Failing tests with a fake transport: a call times out at `reach.callTimeoutMs`; output over
      `reach.maxResultChars` is cut with a note; secret patterns and PII masks are applied; one
      ledger row per call with node, tool, class, verdict, hash, status and latency; a node error
      never throws into the worker.
- [ ] Implement the stdio-over-SSH transport (spawn `ssh -T -o BatchMode=yes` with the node's key,
      user and pinned `known_hosts`), a per-node connection pool, and reconnect with backoff.

#### Task P1.5: The `reach` tools

**Files:** `src/engine/reach-tools.ts`, `src/engine/dispatch.ts` (`neoMcpServers`),
`src/engine/pipeline.ts`, `tests/dispatch.test.ts`.

- [ ] Failing tests: operator turns and dispatches get `reach` when `reach.enabled`; consult,
      ingress, tainted and customer runs never get it; `reach_tools(node)` lists only tools the
      calling project may use.
- [ ] Implement `reach_nodes`, `reach_tools`, `reach`.

#### Task P1.6: Node agent kit

**Files:** `tools/reach-node/` (agent, `Dockerfile`, `compose.yml`, `allowlist.example.json`,
`install.ts`), `tests/reach-node.test.ts`.

- [ ] Failing tests: a tool not in the node allow-list is refused even when called directly;
      `pg_query_ro` refuses anything but one `SELECT`/`WITH` statement and runs as the read-only
      role; logs accept only allow-listed containers and cap lines and bytes; container env values
      are redacted; stdio mode prints nothing but MCP on stdout.
- [ ] Implement; Docker access only through a GET-only socket proxy.
- [ ] `install.ts --print-authorized-key <node>` prints the `restrict,command=…,from=…` line. It
      changes nothing remotely.

#### Task P1.7: Install on prod [OPERATOR]

- [ ] Create `neo_ro` roles (Postgres replica if healthy, ClickHouse `readonly = 1`), the socket
      proxy and the agent container; add the key line; record the steps in
      `/home/prod-ops/docs/` (dispatched to prod-ops).
- [ ] Verify: an `UPDATE` through `pg_query_ro` fails in the database itself; a `docker restart`
      through the proxy fails.

#### Task P1.8: Close raw prod SSH for workers

- [ ] **[OPERATOR]** move `prod_server_key` into `data/reach/keys/`, keep a copy only where the
      operator wants it.
- [ ] Dispatch to prod-ops and eticket-prod: replace raw `ssh` steps in their `CLAUDE.md` with
      `reach` calls.

#### Task P1.9: Status surfaces

**Files:** `src/engine/producers/node.ts`, `src/engine/ledger.ts` (`AttentionSource` gains `node`,
[V `ledger.ts:131`]), `src/engine/commands.ts` (`/nodes`), console catalogues (AR + EN),
`tests/node-producer.test.ts`, `tests/commands.test.ts`.

- [ ] Failing tests: an unreachable node raises one high item, resolved when it answers again; a
      failed read leaves state unchanged (as `reconcile` does today); `/nodes` lists health, last
      call and errors.

**P1 acceptance:** prod-ops answers "which prod containers restarted in the last 24 h and why"
using only `reach`; for 7 days `tool_actions` shows no auto-approved `ssh` to the prod IP; every
reach call has a ledger row with the remote tool and arguments hash; an `act` call in a trusted
folder produces a card.

### P2 — connectors and approve-before-act (3–5 days)

#### Task P2.1: Connector classes for claude.ai tools

**Files:** `src/engine/policy.ts`, `src/config.ts` (`reach.connectorClasses`),
`tests/governor-connectors.test.ts`.

- [ ] Failing tests: with `source: "claudeai"`, `mcp__claude_ai_Gmail__search_threads` is `read`;
      `send_message`, `forward`, `reply`, `trash_thread` are `act`; an unknown connector tool is
      `act` (fail closed); a loop never gets an `act` connector call.

#### Task P2.2: The act card

**Files:** `src/engine/pipeline.ts`, `src/engine/structured-question.ts`, `src/frontends/telegram.ts`,
console catalogues, `tests/act-card.test.ts`.

- [ ] Failing tests: the card shows the target, the exact action and a preview (the email draft);
      approval is single-use and bound to the argument hash; deny means the tool does not run;
      no answer within `governor.approvalTimeoutMs` denies (ADR-0012).

#### Task P2.3: Vendor remote MCP through the gateway

**Files:** `src/engine/reach-gateway.ts` (HTTP transport), `tests/reach-http.test.ts`.

- [ ] Failing tests against a fake Streamable HTTP server: the bearer is sent by the gateway and
      never appears in worker options; `Origin`/protocol-version headers are correct; a 401 marks
      the node `needs-auth`.
- [ ] Configure GitHub (read-only mode; check the header or path [S]) and Cloudflare API MCP with a
      read-only token. Move Stitch behind the gateway (G4).

#### Task P2.4: REST services as `api` cards

**Files:** `docs/tools/coolify.md`, `docs/tools/hostinger.md`, `docs/tools/healthchecks.md`,
`tests/tools-catalogue.test.ts`.

- [ ] Cards with `relay` operations (GET only first); the validator passes.
- [ ] **[OPERATOR]** set `tools.relayEnabled: true`, add the read tokens, set the Coolify IP
      allow-list, confirm the Coolify version is past the CVE-2026-32718 fix.

**P2 acceptance:** a trusted-folder worker asked to send an email produces a card; deny sends
nothing; approve sends exactly once; GitHub/Cloudflare/Coolify reads work with no token in any
worker process.

### P3 — build node and engine-owned jobs (6–10 days + server cost)

#### Task P3.1: Build node [OPERATOR]

- [ ] Choose: new VPS, an existing box, or stay local with caps (D3). Apply the same baseline as
      prod: key-only SSH, default-deny firewall, no public ports, Docker, the node agent.

#### Task P3.2: Move CI runners

- [ ] Dispatch to waselni and contantme: re-register their runners on the build node; remove them
      here after one green run each.

#### Task P3.3: Engine-owned jobs

**Files:** `src/engine/reach-jobs.ts`, `src/engine/ledger-migrations.ts` (`reach_jobs`, next free
version; v13 is the latest on master [V `ledger-migrations.ts:439`]), `src/engine/liveness.ts`
(`BlockedOn.kind` gains `"job"`, [V `liveness.ts:33-38`]), `src/engine/dispatch.ts`,
`tests/reach-jobs.test.ts`.

- [ ] Failing tests: a dispatch with a pending job stays open and its stall clock is paused; the
      result is delivered once to the live session (`followUp`) or to the resumed one
      (`deliverIntoFolder`); after a simulated reload the job is resumed from the ledger; cancel
      sends the transport's cancel; a job over `reach.jobTimeoutMs` ends `lost` with an attention
      item.
- [ ] Implement the transport ADR-0056 chose (engine-polled MCP Tasks or RAP callbacks behind the
      reverse tunnel).

#### Task P3.4: Runner tools

**Files:** `tools/reach-node/` (runner profile), `tests/reach-node-runner.test.ts`.

- [ ] Failing tests: `run_checks` runs only commands from the repo's declared profile; no host
      secrets are mounted; output is capped and the full log is kept as an artifact.

#### Task P3.5: Preamble line

- [ ] Failing test: the preamble names `reach` jobs for heavy builds and stays under 5,000
      characters (`tests/dispatch.test.ts`).

**P3 acceptance:** a full eticket-v3 test run started by a dispatched worker runs on the build
node, survives a Neo reload in the middle, and its result reaches the same todo and thread; the
CI runners are gone from this host.

### P4 — events and proactive extensions (4–6 days)

#### Task P4.1: Node events

**Files:** `src/engine/reach-events.ts`, ledger (`reach_cursors`, events kind `node_event`),
`src/engine/producers/node.ts`, `tests/reach-events.test.ts`.

- [ ] Failing tests: events are deduped on `(node, id)`; a burst becomes one attention item per
      `(node, kind)` per window; a cursor survives a restart; nothing resolves on a failed read.
- [ ] Implement the transport ADR-0056 chose (cursor polling by default).

#### Task P4.2: Signed webhook ingress

**Files:** `src/frontends/web.ts` (`POST /hooks/:source`), `src/config.ts`, `tests/web-hooks.test.ts`.

- [ ] Failing tests: a bad signature → 401 and an event, nothing stored; a replay outside the
      window → 401; an unknown source → 404; rate limit per source; GitHub `X-Hub-Signature-256`
      verified; sentinel's alert body accepted with its secret.

#### Task P4.3: Event trigger for loops

**Files:** `src/engine/trigger.ts` (`{ kind: "event"; source; kinds }`, [V `trigger.ts:5-8`]),
`src/engine/scheduler.ts`, `src/engine/loop-validate.ts`, `tests/trigger.test.ts`,
`tests/scheduler.test.ts`, `docs/loops.md`.

- [ ] Failing tests: a matching event fires the loop once; the payload is placed under
      `## Event (untrusted)`; the run is background class; a tainted event loop runs with
      `TAINTED_DISALLOWED_TOOLS` and no MCP.

#### Task P4.4: Extend the existing proactive surfaces

- [ ] `reach_summary` read tool for the `morning` skill's `Sections: Servers`.
- [ ] `security-sweep` and `error-sweep` definitions opt into `prod:read`
      (**[OPERATOR]** reload them with `tools/create-loop.ts --update`).
- [ ] Disk kit Tier A: leaked stdio MCP containers whose client process is gone.

**P4 acceptance:** a stopped prod container gives one high attention item and one Decisions alert
within 2 minutes; a forged webhook is rejected and logged; 100 events per minute give at most one
alert per `(node, kind)` per window.

### P5 — act with approval (3–5 days)

#### Task P5.1: Act agent on the node

- [ ] Failing tests (node agent): only allow-listed actions; each needs a valid single-use approval
      token bound to the argument hash and not expired; a replayed token is refused.
- [ ] **[OPERATOR]** install the separate act key and forced command on prod.

#### Task P5.2: Engine act flow

- [ ] Failing tests: card → approve → token → call → result, exactly once (idempotency key);
      deny → no call; the ledger names the approver.

#### Task P5.3: First actions

- [ ] `restart_container` (allow-listed names), `coolify_redeploy` of a named app at a named tag,
      Cloudflare cache purge of one URL, GitHub comment, Gmail send of an approved draft. Prod
      releases stay the manual release process [U memory note `eticket-prod-release-is-manual-dispatch`].

**P5 acceptance:** each action runs once per approval; replay is refused; deny does nothing.

### What goes live when (operator steps)

| Step | Who |
|---|---|
| Merge each phase to `dev`, then release to `master` and restart (ADR-0054) | **[OPERATOR]** |
| Re-install the security kit after P0.3 | **[OPERATOR]** |
| Prod roles, socket proxy, agent, keys (P1.7, P5.1) | **[OPERATOR]** |
| Tokens: Cloudflare read, GitHub PAT, Coolify read/deploy; `relayEnabled` | **[OPERATOR]** |
| Build node purchase or choice (P3.1) | **[OPERATOR]** |
| Loading updated loop definitions | **[OPERATOR]** |

---

## 10. Effort

| Phase | Days | Depends on | Restart-gated |
|---|---|---|---|
| P0 spike + hardening | 3–4 | — | P0.3–P0.5 yes |
| P1 gateway + prod read-only | 6–8 | P0 | yes |
| P2 connectors + act card | 3–5 | P1 | yes |
| P3 build node + jobs | 6–10 | P1, ADR-0056 | yes |
| P4 events + proactive | 4–6 | P1, ADR-0056 | yes |
| P5 act with approval | 3–5 | P2 | yes |
| **Total** | **25–38** | | |

Days are SDK-worker days including review. P2 and P3 can run in parallel after P1.

## 11. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| RAP changes its wire format (#101) or stalls | medium | low if contained | Only behind ADR-0056's seam; contract tests; MCP fallback |
| MCP Tasks / auto-background is beta and changes | medium | medium | Pin the SDK; the updater's green gate (ADR-0009) |
| This host is compromised | low–medium (public) | high | Read-only node scopes, `from=` keys, separate act key, rotation, no new listener |
| Prod PII lands in transcripts | medium | high | Aggregate and redact by default; raw rows ask (D4) |
| Approval fatigue | medium | medium | Read is free in trusted folders; act cards are rich; scoped grants later (2026-10-04 plan P4.4) |
| Gateway adds load or hangs the daemon | low | high | Bounded pools, timeouts, contained errors (ADR-0010) |
| Event-triggered loops spend the subscription | medium | medium | Background class + reserve; per-source rate limits |
| Operator inventory is wrong (tgate, old boxes) | medium | medium | D6 before P1.7 |
| Workers still run as root | high | medium | Out of scope here; node-side limits bound the damage; a non-root worker user is a later ADR |

## 12. Open decisions for the operator

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Approve the reach gateway: engine-held credentials, SSH forced command for prod, no new open port | Yes |
| D2 | Approve ADR-0056 after the P0 numbers (where RAP is used, if anywhere) | Follow the pre-registered rules |
| D3 | Build node: new VPS, an existing box, or stay local with CPU caps | New small VPS |
| D4 | Prod rows in worker context: aggregate + redacted by default, raw rows ask each time | Yes |
| D5 | May any `prod-act` ever be auto-approved? | No |
| D6 | Server inventory: is "tgate" the same box as srv1936828? What are the old (159.89.4.38 [U]) and backup boxes for? | Confirm before P1.7 |
| D7 | Keep claude.ai connectors loaded in workers (governed by class) or turn them off with `strictMcpConfig` on some paths | Keep, govern |
| D8 | Close adminli's public DB ports now | Yes |
| D9 | Move the CI runners off this host | Yes, in P3 |
| D10 | Provider firewall for this host (80/443 only, SSH from known IPs) | Yes |
| D11 | GitHub events by webhook to a public Neo route, or keep the 30-min `gh` scan | Keep the scan first |

## 13. Benchmarks: Dots and Duet against Neo

| Capability | ChatGPT Dots [S] | Claude Duet [S] | Neo today [V] | Neo after this plan |
|---|---|---|---|---|
| Own computer | Cloud computer and browser per Dot | Own cloud computer | The operator's own host and folders | Plus nodes on the operator's servers |
| Connectors | 4,000+ apps | 6,000+ connectors and plugins (Claude Marketplace) | claude.ai connectors loaded but ungoverned (G6) | The same catalogue, governed by class |
| Proactive | Background research with read-only tools | Morning brief, checks apps every few hours | Digest 08:00, secretary, sweeps, `morning` skill, inbox | Plus node events and server sections |
| Approve before act | Allow / require approval / block rules; auto-review | Asks before send, pay, sign, delete | Default-escalate, but trust auto-approves (G1, G6) | Classes: reads free, every act asks, prod acts need a bound single-use approval |
| Audit | Activity view [S] | not public | Ledger, `/trace`, labels cut at 60 chars (G2) | One row per reach call with node, tool, approver |
| Cost model | Pro / Business plans [S] | Uses the same usage limits as chats [S] | Subscription with an interactive reserve | Unchanged; events are background class |

Press coverage only for Dots and Duet; no primary source was fetched in this session for either.

## 14. Sources

**Neo repository and host (read-only, this session):** `CLAUDE.md`; `docs/HISTORY.md`;
`docs/CONFIG.md`; `docs/loops.md`; `docs/loops/*.json`; `docs/browser.md`;
`docs/security-checks.md`; `docs/adr/0044-…`; `docs/research/2026-10-22-tools-inventory.md`;
`docs/superpowers/plans/2026-10-04-neo-research-improvements.md` (P4, P5 unbuilt);
`src/engine/{provider-router,governor,session-runner,dispatch,ingress,inbox,loops,trigger,liveness,tools-catalogue,ledger,ledger-migrations,attention,attention-actions,budget,reply-routing,pipeline}.ts`;
`src/engine/producers/{engine,probe}.ts`; `src/frontends/web.ts`; `src/daemon.ts`;
`tools/security/guard.ts`; `gateway/DEPLOY.md`, `gateway/docker-compose.yml`;
`/home/prod-ops/CLAUDE.md`; `/home/eticket-prod/CLAUDE.md`; `/home/eticket-v3/.mcp.json` and
`/home/waselni/.mcp.json` (shapes, values redacted);
`node_modules/@anthropic-ai/claude-agent-sdk/{sdk.d.ts,package.json,manifest.json}`;
read-only queries on `data/ledger.db` (`tool_actions`, `loop_defs`, `loop_state`, `engine_boots`),
`data/trust.db`, `data/inbox.db` (counts only); `docker ps`, `docker stats`, `docker inspect`, `ss`,
`uptime`, `vmstat`, `ps`, `mount`, DNS lookups.

**Memory notes used as leads [U]:** `neo-already-has-email-and-morning-brief`, `new-prod-server-tgate`,
`eticket-prod-remote-readonly-access`, `coolify-compose-config-delivery`, `host-is-dev-but-public`,
`sentinel-uptime-monitor`, `whatsapp-voice-frontdesk-triage`, `customer-email-human-in-the-loop`.

**Infinity (read-only clone, commit `341f6c2`, 2026-10-23):** https://github.com/hydro-project/infinity ·
https://infinity.hydro.run · files cited in §2 · `gh api repos/hydro-project/infinity`,
`gh issue list`, `gh pr list`.

**Official documentation [D]:**
- Agent SDK MCP: https://code.claude.com/docs/en/agent-sdk/mcp
- Agent SDK TypeScript reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Claude Code MCP (auto-background, tasks, timeouts, reconnect): https://code.claude.com/docs/en/mcp
- MCP 2025-11-25 changelog: https://modelcontextprotocol.io/specification/2025-11-25/changelog
- MCP transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP Tasks extension: https://modelcontextprotocol.io/extensions/tasks/overview
- Coolify API permissions: https://coolify.io/docs/api/permissions
- Cloudflare MCP servers: https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/

**Secondary [S]:**
- Claude Duet: https://www.eesel.ai/blog/claude-duet ·
  https://tech-insider.org/claude-duet-workplace-agent-6000-apps-dots-muse-2026/ ·
  https://letsdatascience.com/news/anthropic-opens-claude-duet-research-preview-for-proactive-a-16522f5d ·
  https://www.vktr.com/ai-platforms/claude-duet-anthropic-previews-an-ai-agent-that-messages-you-first/
- ChatGPT Dots: https://www.reworked.co/digital-workplace/openai-introduces-alwayson-dots-agents/ ·
  https://runtimewire.com/article/openai-launches-dots-always-on-agents ·
  https://t2online.in/tech/tech-news/openai-launches-dots--always-on-ai-agents-that-work-in-the-background-across-more-than-4-000-apps/2008337 ·
  local notes `docs/research/2026-10-04-neo-research/neo-vs-new-agents.md`
- Coolify CVE-2026-32718: https://app.opencve.io/cve/CVE-2026-32718
- GitHub MCP read-only mode: https://github.blog/ai-and-ml/generative-ai/a-practical-guide-on-how-to-use-the-github-mcp-server/ ·
  https://glama.ai/mcp/servers/@github/github-mcp-server/blob/bf6467855c13d3b8f5cf72f8dfd9c86f8336b20b/docs/server-configuration.md
