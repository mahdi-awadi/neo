# Neo — current state of the codebase (internal inventory, 2026-11-02)

Scope: `/home/user/neo` at `master`/`c1476b5` ("docs: research note — dsh-superagent review", 250 commits). All sources are local files; paths below are repo-relative unless absolute. Status words used throughout: **Done** (exists, tested, in master), **Partial** (a base exists to extend), **Missing** (nothing yet), **Planned** (a written plan/ADR exists, not built), **Rejected** (a standing decision says no). "Restart-gated" means merged on local master but the running daemon has not been restarted to pick it up (see HANDOFF.md).

Note on verification in this container: `node_modules` is empty here (`ls node_modules | wc -l` = 0), so `bunx tsc --noEmit` fails with `Cannot find type definition file for 'bun'` and `bun test` runs only 423 of the tests (341 pass / 82 fail, all import failures). These are environment artefacts, not code state. The repo's own last recorded baseline is "tsc clean, 1541 pass (5 full runs clean)" — [HANDOFF.md](../../../../HANDOFF.md) L11. Static count: 122 test files under `tests/`, ~1,539 `test(`/`it(` call sites.

---

## 1. Architecture: three layers, "no AI in the engine", provider router / compliance firewall, worker launch paths and profiles

### Takeaway
Neo is a deterministic Bun/TypeScript daemon (frontends → engine → SDK workers) in which every policy, schedule, budget, routing and record is code; AI runs only inside Claude Agent SDK (or Codex SDK) workers and a planned Gemini customer path. All worker launches funnel through one `RunDeps`/`profileDeps` resolution point with eight named launch-path profiles.

### Cited Findings
- Three layers: Frontend (Telegram / web console; email/WhatsApp planned) ↔ Engine (orders · provider routing · governance · budget · ledger, "deterministic. THIS repo's job") ↔ Worker (Claude Agent SDK default, Codex SDK optional) via `query(task, { cwd, canUseTool, mcpServers, settingSources })` — [CLAUDE.md](../../../../CLAUDE.md) "Architecture (three layers)".
- "The engine itself contains **no AI** — it routes, governs, meters, and records. AI lives only inside SDK workers (Claude, on your subscription) and customer-message reading (Gemini)." — [CLAUDE.md](../../../../CLAUDE.md) "Core principle"; glossary restates it: "The engine holds no AI." — [CONTEXT.md](../../../../CONTEXT.md) L3-6.
- Provider router is 20 lines and hard-codes the firewall: `source "neo"` → configured own-work provider (default subscription); `source "customer"` → "NEVER the subscription. MVP refuses (Gemini path is Phase 3)… a HARD rule here, independent of config" — [src/engine/provider-router.ts](../../../../src/engine/provider-router.ts) header. Config: `providers: { ownWork: "subscription" | "codex", customerWork: "gemini" }` — [docs/CONFIG.md](../../../CONFIG.md) L41.
- **Status of the Gemini path: Missing / Planned (Phase 3b).** `GEMINI_API_KEY` exists in config, "*(empty)*" by default — [docs/CONFIG.md](../../../CONFIG.md) L16; the kickoff prompt says "flip it to `customer` → `{provider:"gemini"}` once the path exists" — [docs/next-session-prompt.md](../../next-session-prompt.md) L25.
- Execution core: `src/engine/session-runner.ts` (1,143 lines) exposes `runOrder` (single-shot) and `startOrder` (live session with a streaming input channel, `followUp`/`interrupt`), provider-neutral, with Claude and Codex adapters behind it — header of [src/engine/session-runner.ts](../../../../src/engine/session-runner.ts).
- Verified SDK surface used: `cwd`, `settingSources: ["user","project"]`, `skills: "all"`, `systemPrompt: { preset: "claude_code" }`, `permissionMode: "default"`, `canUseTool`, `mcpServers`, `resume`, `includePartialMessages` — [CLAUDE.md](../../../../CLAUDE.md) "Verified Agent SDK surface"; [docs/sdk-notes.md](../../sdk-notes.md) L43-68.
- Worker launch paths: eight profiles — `company`, `project`, `dispatch`, `loop`, `judge`, `ingress`, `handoff`, `secretary` — each `{ model?, effort?, skills?, maxTurns? }`; resolution `base.model ?? profile.model ?? models.default` then alias expansion, in `profileDeps` (`src/engine/worker-profile.ts`), "the ONLY place path→model/effort/skills/env routing happens" — [docs/CONFIG.md](../../../CONFIG.md) L158-176; [ADR-0005](../../adr/0005-the-worker-model-is-pinned-in-config-not-inherited.md).
- Pinned model default `claude-opus-5-5[1m]`; aliases `opus/sonnet/haiku/fable` expanded before the SDK; `best`/`opusplan` deliberately not pinned — [docs/CONFIG.md](../../../CONFIG.md) L94-156; [ADR-0005](../../adr/0005-the-worker-model-is-pinned-in-config-not-inherited.md).
- Default profiles: only `company` and `ingress` set `effort: "low"`; everything else `{}`; "Economy mode" (Haiku on `handoff`/`judge`/`ingress`) is opt-in, measured, and code-writing paths are **not eligible** — [docs/CONFIG.md](../../../CONFIG.md) L172-186.
- Interactive vs background **work class** follows the *originating trigger*, decided once per launch (`pipeline.ts` interactive, `ingress.ts` background) and captured in the `dispatch` tool's closure — [ADR-0001 amendment](../../adr/0001-interactive-reserve-gates-background-work-only.md) L50-64.
- Company session ("the company"/chief-of-staff) is an always-on, pinned, idle registry entry rooted at `COMPANY_FOLDER` (default `<repo>/agent`), the default target for free-text orders — [src/engine/default-project.ts](../../../../src/engine/default-project.ts) header; `agent/` is a Go workspace (Dockerfile, go.mod, handoff.go, inbound.go) per `ls agent`.
- Company MCP tools (in-process, built in `neoMcpServers` in `src/engine/dispatch.ts`): `send_file`, `ask_operator`, `sessions`, `dispatch`, `todo` — [src/engine/dispatch.ts](../../../../src/engine/dispatch.ts) L1420-1578; plus `memory`/`memory_log`/`memory_search` when a folder is in `memory.scopes` — [src/engine/memory-tool.ts](../../../../src/engine/memory-tool.ts) L164-265. Optional MCPs: codebase-memory (`CODEBASE_MEMORY_BIN`), Stitch (`STITCH_API_KEY`), Playwright (opt-in flag, operator paths only) — [docs/CONFIG.md](../../../CONFIG.md) L505-514.
- Module map (file headers read for every `src/engine/*.ts`): 73 engine modules + `frontends/telegram.ts` (1,242 lines), `frontends/web.ts` (496), `frontends/telegram-flood.ts`, `daemon.ts` (485), `config.ts` (575). Largest: `ledger.ts` 1,821, `dispatch.ts` 1,671, `session-runner.ts` 1,143, `pipeline.ts` 1,047, `context-policy.ts` 823, `loops.ts` 712, `commands.ts` 694.

### Inferences
- The firewall is structurally two gates: the provider router (customer never → subscription) and the tool envelope (customer briefs get zero tools). Everything "customer" today is inbox review + ingress scaffolding; no customer-facing AI reply path has ever run on Gemini.
- Any state-of-the-art proposal that puts a classifier, summariser or planner in the engine conflicts with the core principle and will be rejected on sight; proposals must land as prompt rules, tool-boundary schemas, or deterministic ledger routing (the dsh research note says exactly this in §2.4).

### Gaps
- No live measurement of the Codex path exists beyond unit tests; nothing in the repo records a production Codex run (see §9).

---

## 2. Work model: orders, company session, dispatch tool, todo queue (ADR-0008), focus/pin, threads/trace (ADR-0015/0016), plan registry (ADR-0019), attention items (ADR-0018), decisions / ask_operator / structured questions / secretary, priority routing

### Takeaway
The work model is mature and almost entirely Done (most of it restart-gated as of HANDOFF): the operator talks to the company; the company writes tailored briefs and dispatches them; every brief is a durable per-project todo; every message has a ledger id and a thread; plans and attention items are engine-registered; blocking questions are schema-enforced decisions routed to an unmuted Decisions channel.

### Cited Findings
- **Order** = folder + task + source; **Dispatch** = sending an order into another project's folder as its own governed session, work class inherited — [CONTEXT.md](../../../../CONTEXT.md) L16-23, L98-102.
- The `dispatch` tool is "given ONLY to the default project ('the company')… The company writes the brief (a tailored prompt), so the sub-project gets a clear order, not the operator's raw message" — [src/engine/dispatch.ts](../../../../src/engine/dispatch.ts) header. Dispatch is non-blocking; the company is always free — [docs/HISTORY.md](../../HISTORY.md) L46-48.
- **No wall clock on dispatch (ADR-0007, Done):** `dispatchTimeoutMs`/`dispatchTimeoutMaxMs`/`timeoutMinutes` removed; the only automatic abort is the stall limit (`dispatchStallMs` 5 m of true silence); "done" = SDK `session_state_changed: idle` via `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`; progress digest every `dispatchProgressMs` (10 m); durable `dispatcher_inbox` for final results; "stopped at" line on abnormal ends; boot recovery — [ADR-0007](../../adr/0007-a-dispatch-has-no-wall-clock-and-always-reports-to-its-dispatcher.md). Known gap recorded there: the CLI's idle check "does not count a background **Bash** command (`run_in_background`)" (L523-526).
- **Per-project todo queue (ADR-0008, Done):** `project_todos` + `todo_paused` tables; busy project → queued "as #N, position P"; released on settle and on every tick; `todoOnFailure` `continue|pause`; boot marks a `running` todo `failed` with its stop point; company `todo` tool + `/todo` + console Queue tab; one project runs one todo at a time — [ADR-0008](../../adr/0008-a-busy-project-gets-a-durable-todo-queue-released-on-settle.md); [src/engine/todo-queue.ts](../../../../src/engine/todo-queue.ts) header.
- **One-shot focus (Done):** default follow-up target is the company; `/use <name>` focuses once, `/pin` holds, `/unpin`/`/company`/`/main` returns; reply-to-message routes to that project; `findByChat` returns only the focused session — [docs/HISTORY.md](../../HISTORY.md) L113-122; [README.md](../../../../README.md) L186-216.
- **Trace spine (ADR-0015/0016, Done, restart-gated):** every operator message gets an integer ledger id shown as base36 ref (`m4f2`); cause columns (`cause_msg_id`/`thread_id`) on orders, todos, decisions, dispatcher_inbox, message_routes, events; registry holds each session's current cause; threads join only by explicit reply/console composer (no time window, no text matching); thread state `open|waiting|done|failed` derived by `deriveThreadState` in `thread-state.ts`; `/trace <ref>` and `GET /api/trace/:ref`; `tool_actions` table; numbered ledger migrations v1–v8 — [ADR-0015](../../adr/0015-every-operator-message-has-a-ledger-id-and-everything-carries-its-cause.md), [ADR-0016](../../adr/0016-a-thread-is-the-unit-the-operator-tracks-and-its-state-is-derived.md), [docs/HISTORY.md](../../HISTORY.md) L819-828.
- **Plan registry (ADR-0019, Done, restart-gated):** at every run end the engine diffs `plans.paths` globs (`docs/**/plans/**/*.md`, `docs/**/specs/**/*.md`, …), registers each file in `plans`, sends each new content hash once as a Telegram card with Approve / Changes / Execute / Drop / Done; status `draft→sent→approved→executing→done|abandoned`; `maxPerRun` 3; `/plans` — [ADR-0019](../../adr/0019-the-engine-registers-and-sends-every-plan.md); [docs/CONFIG.md](../../../CONFIG.md) L75.
- **Attention items (ADR-0018, Done, restart-gated):** one `attention_items` table keyed `(project, kind, key)`; producers `git`, `github`, `engine`, `plan`, `restart`, `probe` in `src/engine/producers/`; reconcile = open / seen / resolve / reopen, and a failed read changes nothing; `/attention` with → todo / snooze / dismiss / remove-worktree; daily digest at `attention.digestAt` (`0 8 * * *`) — [ADR-0018](../../adr/0018-attention-items-one-table-many-deterministic-producers.md); [docs/CONFIG.md](../../../CONFIG.md) L76-79.
- **Project dashboard (P6, Done, restart-gated):** `src/engine/project-view.ts` read model feeds the console Projects tab, `/project <name>` (`/p`) and the company's `sessions` tool; optional `healthUrl` and `deployedVersionUrl` probes — [docs/HISTORY.md](../../HISTORY.md) L855-870.
- **Decisions queue / priority routing (Done):** deterministic priority `decision|alert|result|progress|done` from the *call site* (`src/engine/priority.ts`), split into a muted DM firehose (`progress`/`done`) and an unmuted **Decisions** channel (`decisionsChatId`) for `decision`/`alert`/`result`; `routeChat` guarantees progress can never reach the group; a tap, typed "Other", or a Telegram reply resolves the decision row and resumes the raising session — [docs/HISTORY.md](../../HISTORY.md) L272-349; [src/engine/priority.ts](../../../../src/engine/priority.ts) header.
- **`ask_operator` (Done):** schema-enforced "matured decision" — `title`, `context` (root cause), 2–5 `options` each with a trade-off detail, `recommendation`; Zod rejects shapeless/bundled asks; "raise exactly ONE decision per call" — [docs/HISTORY.md](../../HISTORY.md) L351-381; spec `docs/superpowers/specs/2026-09-09-matured-decisions-design.md`. The **maturing reviewer** (fresh worker sharpens a shallow ask before posting) is designed, **not built** — [WIP.md](../../../../WIP.md) L142-146.
- **Native `AskUserQuestion` serviced (Done):** parsed into a `StructuredAsk` (1–4 questions, 2–5 options, multi-select, implicit "Other"), stored on the decision row's `spec` column, tappable keyboards — [docs/HISTORY.md](../../HISTORY.md) L296-321; [src/engine/structured-question.ts](../../../../src/engine/structured-question.ts) header.
- **Secretary loop (Done, opt-in):** `secretaryCron` default `0 8-22/2 * * *`; engine renders the open decisions queue deterministically into the prompt; the worker only phrases ONE digest; `secretaryStaleHours` 24 flags STALE; a no-op gate skips the run when the queue is empty — [docs/loops.md](../../loops.md) L39-48.
- Operator commands (same on Telegram and web): `/open`, `/list`/`/ls`/`/status`, `/use`, `/pin`, `/unpin`, `/kill`, `/trust`, `/loop`, `/todo`/`/queue`, `/trace`, `/plans`, `/attention`, `/project`/`/p`, `/gated`, `/updates`, `/inbox`, `/recent`/`/history`, `/usage`, `/sdk`, `/reload`, `/help`, plus `/events [<kind>]`, `/decisions` — [README.md](../../../../README.md) L186-216; [docs/HISTORY.md](../../HISTORY.md) L173-175.
- Escalations are themselves tracked decisions (`src/engine/escalation.ts`), but the Allow/Deny resolver is still Telegram's in-memory `pending` map and the web channel's own map; a typed yes/no never reaches either — **Partial**, kept as P0 — [docs/research/2026-10-04-neo-research-idea-map.md](../2026-10-04-neo-research-idea-map.md) L26-27, L101-103.
- **Missing:** `/now` steer of a running turn (follow-ups are delivered only at a turn boundary because the input async-generator is parked at `yield` until the SDK pulls the next input) — [docs/investigations/2026-07-25-post-update-issues.md](../../investigations/2026-07-25-post-update-issues.md) "Issue 1"; idea map L23.
- **Missing:** structured end-of-work report from the worker (ready/blocked/failed/dropped); today the engine *infers* the outcome from settle + stop point + prose (`dispatch-report.ts`) — [docs/research/2026-11-02-dsh-superagent-and-neo-improvements.md](../2026-11-02-dsh-superagent-and-neo-improvements.md) §2.1 #1, proposal A.
- **Missing:** the operator's verbatim order riding with the brief; worker "handback" of an out-of-scope follow-up — same note, #4, #5, proposal D.

### Inferences
- Because every artefact already carries a cause and the queue/decision/plan tables are ledger-native, most "add a ticket/PR/report object" proposals from the literature can be expressed as new columns or producers on existing tables rather than new stores (the idea map explicitly forbids "a second table" for the work board).

### Gaps
- Whether the P2–P6 traceability features are live in production is unknown from the repo: HANDOFF says they sit on local master `1d5921a`, "NOT pushed, restart-gated" awaiting an operator restart — [HANDOFF.md](../../../../HANDOFF.md) L8, L15.

---

## 3. Governance: governor (default-escalate, PreToolUse hook, path fence, trust store, out-of-folder writes ADR-0011/0012), escalation reminders/timeouts, tainted briefs

### Takeaway
The governor is one `decide()` function wired twice (PreToolUse hook first, then `canUseTool`), default-ESCALATE with a path fence; trust auto-approves escalations per folder but never the fence or customer work; out-of-folder writes are pre-approved for own work by operator order; approvals remind every 30 min and fail closed at 2 h; customer-tainted briefs run with zero tools.

### Cited Findings
- "Default-ESCALATE: a tool this file doesn't recognize asks the operator… Wired into the SDK twice, through this ONE function: a PreToolUse hook… and the `canUseTool` callback. Autonomous paths (loops, customer-driven briefs) auto-deny escalations, so for them default-escalate = default-deny." — [src/engine/governor.ts](../../../../src/engine/governor.ts) header (110 lines).
- `RISKY_BASH` keyword regex is "Defense-in-depth only (a keyword regex is bypassable); the real guards are the path fence + default-escalate" — same header. The regex includes `curl`, `wget`, `git push`, `deploy`, the bare word `production` — [ADR-0004](../../adr/0004-a-loop-prompt-is-a-standing-brief.md) L251-254.
- **ADR-0006 (Done):** live probe on SDK 0.3.286 showed a project `.claude/settings.json` allow rule (`Bash(git:*)`) let `git push --dry-run` run with zero governor calls; fix = `buildGovernorHook` as a `PreToolUse` hook with no matcher (sees subagent and MCP calls), returns `ask` on anything not allowed, synchronous, never throws (a throwing hook fails **open**), and `permissionMode`, `canUseTool`, `hooks` go last in `sdkOptions` — [ADR-0006](../../adr/0006-the-governor-runs-as-a-pretooluse-hook-first.md); spike files `spike/governor-bypass-probe.ts`, `spike/hook-ask-spike.ts`.
- **Trust (Done):** per-folder store `data/trust.db` with rows `on`/`off`; no row = never seen = not trusted; `trustNewProjects: true` (operator choice 2026-10-02) seeds a never-seen folder `on` at first session start; `/trust [<project-or-folder>] [on|off]` — [src/engine/trust.ts](../../../../src/engine/trust.ts) header; [docs/HISTORY.md](../../HISTORY.md) L721-735.
- **ADR-0011 (Done):** `decide` marks an out-of-folder Write/Edit `fenced`; `buildCanUseTool` auto-approves only when not fenced and source is not `customer` — [ADR-0011](../../adr/0011-trust-never-lifts-the-fence.md).
- **ADR-0012 (Done, restart-gated):** `governor.outOfFolderWrites: "allow"` (default) after fence stalls of 4 h+ (gold) and 7 h (waselni) on auto-memory/`/tmp` writes; own work only, ingress strips the knob; `patientApproval` reminds every `approvalRemindMs` (30 m) and denies after `approvalTimeoutMs` (2 h), records `approval_timeout`; "Timeout = allow" rejected — [ADR-0012](../../adr/0012-out-of-folder-writes-are-pre-approved-and-approvals-never-wait-forever.md); [docs/CONFIG.md](../../../CONFIG.md) L279-291.
- **Tainted briefs (Done):** `TAINTED_DISALLOWED_TOOLS` + no MCP + no resume + auto-memory off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) for any brief embedding customer text — [CONTEXT.md](../../../../CONTEXT.md) L229-232; [src/engine/ingress.ts](../../../../src/engine/ingress.ts) header; [ADR-0020](../../adr/0020-claude-auto-memory-is-the-project-memory.md) decision 1.
- Agent-team subagents re-enter the same `canUseTool`, so the fence holds inside teams; a team subagent's `git push` was seen escalated in the ADR-0006 probe — [src/engine/agent-teams.ts](../../../../src/engine/agent-teams.ts) header; [ADR-0006](../../adr/0006-the-governor-runs-as-a-pretooluse-hook-first.md) decision 1.
- `buildCanUseTool` is "stateless + try/catch fail-safe + self-healing" after the 2026-07-27 "Stream closed" incident (a rejected `onEscalation` used to leave every later risky tool rejecting) — [docs/investigations/2026-07-27-approval-channel-stream-closed.md](../../investigations/2026-07-27-approval-channel-stream-closed.md) "Root cause".
- **Planned, not built (P4):** a `policy_rules` table (allow/ask/block · tool · glob · project), `/never`, scoped grants (Once / This task / 1h / Always), learned "offers" (never auto-applied), outbound content scan, `/audit` — [docs/superpowers/plans/2026-10-04-neo-research-improvements.md](../../superpowers/plans/2026-10-04-neo-research-improvements.md) "P4".
- **Rejected:** an AI approval classifier; auto-promotion of autonomy; plan approval pre-authorising listed steps ("conflicts with per-call default-escalate") — [idea map](../2026-10-04-neo-research-idea-map.md) L91, L109, L116-117.

### Inferences
- The governor is deliberately coarse (allow-set + fence + risky regex + escalate); the recognised next step is precise *deny/ask* rules, since trust is on by default for new projects. Any proposal for fine-grained permission policy should be framed as the P4 rules table amending ADR-0011, not a new mechanism.

### Gaps
- No data in the repo on the volume of escalations per day or the share auto-approved by trust (the ledger `decisions`/`tool_actions` tables would hold it, but no report is checked in).

---

## 4. Reliability: liveness/wedged detection, stall detector, API retry ladder and cooldown, graceful reload + session restore, boot reconciliation, engine event log, fault containment (ADR-0010), Telegram flood gate and chunking

### Takeaway
Reliability work is extensive and largely Done: one derived session state from one activity clock (ADR-0003), a 5-minute stall abort paused while awaiting the operator, a 30s→2m→8m jittered retry ladder with a 60 s engine-wide cooldown on background work, SIGTERM/`/reload` drain + snapshot + restore, boot recovery of unfinished dispatches/todos, a 50k-row structured event log, per-unit fault containment with a process safety net, and a Telegram flood gate plus table-aware 4096-char chunking.

### Cited Findings
- **Liveness (ADR-0003, Done):** `src/engine/liveness.ts` is "the ONE place" that decides working/wedged from two clocks (`lastActivityAt` = any streamed SDK event, decides; `lastOutputAt` = reported, never judged); derived states `starting | working | quiet | idle | awaiting-operator | wedged`; `active()` became a flag not a counter difference; every abort records `dispatch_stall_evidence` first; thresholds `liveness.wedgedAfterMs` 300000, `quietAfterMs` 180000 — [ADR-0003](../../adr/0003-one-activity-clock-one-derived-session-state.md); [docs/CONFIG.md](../../../CONFIG.md) L519-549.
- **Stall detector:** `dispatchStallMs` 5 m of true silence, not counting operator waits or API backoff; `dispatchGraceMs` 75 s wrap-up; watchdog `stuckAfterMs` 10 m / `longTurnAlertMs` 20 m / `alertRepeatMs` 15 m, observer only — [docs/CONFIG.md](../../../CONFIG.md) L46-47, L82-84; [src/engine/watchdog.ts](../../../../src/engine/watchdog.ts) header.
- **Spin detection (Done):** `dispatchSpinDigests` 3 identical digest fingerprints → `dispatch_spinning` event + high attention item + one alert; `dispatchSpinPolicy` `alert|wrapup`; `toolLoopLimit` 8 identical tool calls in a turn, exempt `BashOutput`/`TaskOutput` — [docs/CONFIG.md](../../../CONFIG.md) L49-52.
- **API retry (Done):** `session-runner` reads `is_error`/`api_error_status`/result text; `api-retry.ts` ladder `apiRetryLadderMs` `[30000,120000,480000]` (length = retry count), `apiRetryJitterFrac` 0.2, re-sends the SAME brief into the SAME session prefixed with a half-done warning; `apiCooldownMs` 60 s holds new background work; only a `rejected` rate-limit window governs a wait (an `allowed_warning` used to park a retry up to 7 days) — [docs/HISTORY.md](../../HISTORY.md) L86-104, L490-494; [docs/CONFIG.md](../../../CONFIG.md) L56-58.
- **Graceful reload (Done):** SIGTERM or `/reload` → lifecycle gate refuses new work, wrap-up follow-up into every running worker, `drainWindowMs` 90 s, hard interrupt, snapshot `open_sessions` (folder + SDK resume id + cause + `sdk_provider`), exit 0, `restoreSessions()` at boot; systemd `TimeoutStopSec` caveat — [src/engine/reload.ts](../../../../src/engine/reload.ts) header; [docs/HISTORY.md](../../HISTORY.md) L73-84.
- **Boot reconciliation (Done):** a `dispatch_start` without `dispatch_end` inside `dispatchRecoverWindowMs` (24 h) gets its end recorded as `interrupted: "engine restart"` with the folder's HEAD now; running todos → `failed` with stop point; boot never wakes the company — [ADR-0007](../../adr/0007-a-dispatch-has-no-wall-clock-and-always-reports-to-its-dispatcher.md) decision 6; [ADR-0008](../../adr/0008-a-busy-project-gets-a-durable-todo-queue-released-on-settle.md) decision 6.
- **Cross-SDK resume (Done):** session ids carry the SDK that minted them (`orders.sdk_provider`, `open_sessions.sdk_provider`); `canResumeWith()` (`src/engine/sdk-choice.ts`) refuses a proven cross-SDK resume; "No conversation found" is a rejected precondition, restart cold once, replay the brief — [docs/HISTORY.md](../../HISTORY.md) L196-211.
- **Engine event log (Done):** ledger `events` table, `recordEvent`/`listEvents`, prune every 1000 inserts keep `eventsKeep` 50k, kinds + small metadata only, `/events [<kind>]` — [docs/HISTORY.md](../../HISTORY.md) L162-176.
- **Fault containment (ADR-0010, Done, restart-gated):** `faults.report()` never throws → log + `engine_fault` event + deduplicated alert (`faults.dedupeMs` 15 m, `maxAlertsPerHour` 6) + company handoff (`maxHandoffsPerHour` 3, signatures ignore digits); `guard`/`contain` per unit; `uncaughtException`/`unhandledRejection` keep running; only startup failure or Telegram 401/409 exits; WAL + `busy_timeout` 5 s on every SQLite store; health check (lag 2 s, RSS 2048 MB, `SELECT 1`) — [ADR-0010](../../adr/0010-errors-are-contained-per-unit-and-reported-never-fatal.md); [docs/CONFIG.md](../../../CONFIG.md) L328-353.
- **Loop-failure isolation (Done):** `tickScheduler` catches sync throws and rejecting promises per loop; `commandGoal` reports ENOENT as not-met — [docs/HISTORY.md](../../HISTORY.md) L149-160.
- **Telegram flood gate (Done):** one gate on every Bot API send; short 429 waited once, long 429 holds that chat and reports lost count on recovery; `telegramFloodMaxWaitMs` 30 s; `telegramToolSteps: false` because tool lines "were ~86% of outbound volume and caused a ~9h Telegram 429 ban" — [src/frontends/telegram-flood.ts](../../../../src/frontends/telegram-flood.ts) header; [docs/CONFIG.md](../../../CONFIG.md) L72-73.
- **Chunking (Done):** `chunkText`/`deliverChunked`/`chunkMarkdown` in `format.ts` split under Telegram's 4096 cap on line boundaries, re-emit table headers per chunk, fall back to plain text if HTML is rejected; tool-result `↳` previews (600 chars) for Bash/web/MCP/Task — [docs/HISTORY.md](../../HISTORY.md) L226-241.
- **Known gap (recorded, open):** the budget meter window "NOT persisted: the window lives in this process, so a restart zeroes it" — [src/engine/budget.ts](../../../../src/engine/budget.ts) header L72.
- **Known gap (recorded, open):** "the unbounded web `events[]` the audit noted is out of this scope" (later bounded by ADR-0014 `webFeedWindow` 500) — [WIP.md](../../../../WIP.md) L177; [ADR-0014](../../adr/0014-the-console-feed-is-a-bounded-window-resumed-by-event-id.md).

### Inferences
- The liveness contract pushes the liveness burden onto the worker (foreground polling <90 s) because the SDK exposes no in-tool progress; the dsh note proposes a spike on whether the SDK wakes a session on background-task exit, which would let that contract relax (§2.3).

### Gaps
- No uptime / MTBF figures or crash counts after ADR-0010 are recorded in the repo.

---

## 5. Context & memory: context policy, boundary handoffs (ADR-0021), checkpoints, codebase-memory indexing before dispatch, memory Phase 2 (off), Claude auto-memory (ADR-0020), learned cache TTL, per-model window (ADR-0013)

### Takeaway
Context lifecycle is data-driven and Done: occupancy from the SDK-reported window, a 40/60/90 % band, handoffs only at task boundaries or committed checkpoints (steered through the governor hook), notes inlined into the continuation; the engine pre-indexes folders in codebase-memory before dispatch; Neo's own memory Phase 2 exists but is off, and Claude auto-memory is (proposed to be) the one project memory.

### Cited Findings
- **Context policy:** `src/engine/context-policy.ts` (823 lines) "Deterministic context policy — NO AI. Measures a session's real context load from its own transcript JSONL… Fail OPEN on read errors" — file header.
- **ADR-0013 (Done):** window comes from `result.modelUsage[*].contextWindow`, kept per model in ledger `model_windows`, operator override `contextPolicy.windowTokensByModel`; a 200k guess never `clear`s a session; before this, Opus 5.5 sessions (1M) were measured against 200k, console showed 235–306 %, and "519 `clear` verdicts since 2026-07-08, only 2 of them truly at 85% of 1M. Each `clear` dropped a session with no handoff note" — [ADR-0013](../../adr/0013-the-context-window-comes-from-the-sdk-not-a-code-table.md); [docs/HISTORY.md](../../HISTORY.md) L796-804.
- **ADR-0021 (Done, restart-gated):** bands healthy <0.40 `sweetSpotPct`, above <0.60 `checkpointPct`, heavy <0.90 `emergencyPct`; eager handoff at settle while the cache is warm; mid-task steer via the PreToolUse hook denying all tools except note-writing/commit; continuation gets the note inline ("8 of 47 measured sessions told to read it never did"); never with uncommitted work except emergency; `context_events` rows; derived from 31,585 Opus turns in 125 sessions, handoff ≈ $0.6 pays back in ~10 turns — [ADR-0021](../../adr/0021-context-handoffs-happen-at-boundaries-not-at-thresholds.md). Codex gets boundary handoffs only (no hook).
- `src/engine/context-checkpoint.ts`: a pure state machine over per-turn usage + tool calls that arms the checkpoint after a commit/plan-step with a clean tree and measures "orientation" (`handoffOrientationMaxSteps` 70) — file header; [docs/CONFIG.md](../../../CONFIG.md) L240-252.
- **Learned cache TTL (Done):** `staleResumePct` 0.35, `cacheTtlFallbackMs` 1 h, `cacheTtlMinObservations` 5, `cacheObsWindow` 50 over ledger `cache_observations` — [docs/CONFIG.md](../../../CONFIG.md) L254-267.
- **Codebase-memory before dispatch (Done):** `ensureIndexed` in `src/engine/codebase-memory.ts` indexes the target folder if missing (`codebaseMemoryIndexTimeoutMs` 5 m, best-effort, process-lifetime cache) because "the governor denies subagents the index tools"; preamble makes `list_projects` → `get_architecture` → `search_code/query_graph` REQUIRED — [docs/HISTORY.md](../../HISTORY.md) L53-67; [src/engine/dispatch.ts](../../../../src/engine/dispatch.ts) `briefWithProjectDocs`. codebase-memory was chosen over gitnexus by a measured head-to-head — [docs/superpowers/specs/2026-07-23-context-efficiency-design.md](../../superpowers/specs/2026-07-23-context-efficiency-design.md) §4.
- **Memory Phase 2 (Done, default off):** capped `§`-entry MEMORY.md/USER.md, frozen snapshot at worker start, FTS5 daily-log recall (keyword, not semantic), `memory`/`memory_log`/`memory_search` tools, nightly `memory-dream` loop with engine-enforced budgets (`dreamMaxMutations` 3, `dreamMaxAdds` 1, `dreamMaxNetChars` 250), `DREAMS.md` diary; `memory.scopes: []` = total no-op — [docs/CONFIG.md](../../../CONFIG.md) L355-461.
- **ADR-0020 (proposed; item 1 built, 2–4 await operator):** Claude Code auto-memory at `~/.claude/projects/<repo-root>/memory/` is the live learned memory (34 dirs, ~730 notes measured 2026-10-06; eticket-v3 MEMORY.md 18.5 KB ≈ 4–5k tokens per session); decision: keep it, console shows/searches it (not built), preamble says where facts go (not built), Neo memory not turned on as a second store, "re-pointed at auto-memory, or the module is retired" (not built) — [ADR-0020](../../adr/0020-claude-auto-memory-is-the-project-memory.md).
- Context-efficiency later phases (Planned): Phase 3 per-project onboarding pipeline, Phase 4 telemetry & skill governance — [spec §7](../../superpowers/specs/2026-07-23-context-efficiency-design.md) L172-190; CLAUDE.md "Next:" line.
- **Rejected (spec §8):** model downgrade on any code-writing path; raw-API context-editing betas; engine-side AI/embeddings; auto-installing MCP/skills; a second code-intel MCP — [spec §8](../../superpowers/specs/2026-07-23-context-efficiency-design.md) L196-201.

### Inferences
- Two memory systems coexist (Neo Phase 2 off, auto-memory on); the repo's own direction is to consolidate on auto-memory. Proposals for "agent memory" should target the ADR-0020 items 2–4 (visibility, search, retirement/re-pointing), not a third store.

### Gaps
- ADR-0020's status is "proposed"; HANDOFF lists its approval as an open operator decision — [HANDOFF.md](../../../../HANDOFF.md) L20.

---

## 6. Loops: trigger→action→goal runtime, goal kinds, bounds, data-driven CRUD, tools/create-loop.ts, built-ins, known gaps (ADR-0004)

### Takeaway
The loop runtime (manual/interval/cron triggers; command or LLM-judge goals; per-fire bounds; derived heartbeat; data-driven definitions editable without restart) is Done, with three recorded gaps: loop workers get no preamble and no `ask_operator`, judge-run cost is not counted in the loop budget, and `judgeGoal`'s `timeoutMs` is ignored.

### Cited Findings
- Loop = trigger + repeated action + goal; always background work — [CONTEXT.md](../../../../CONTEXT.md) L173-176. Modules: `goal.ts` (command exit-0 or judge worker's strict last line), `trigger.ts` (5-field cron matcher, no L/W/?), `loop-runner.ts`, `project-loop.ts`, `scheduler.ts` (due + enabled + free slot + unthrottled, `lastRun` written before start), `loops.ts` (library + `/loop`), `heartbeat.ts` (tick derived from enabled loops, 60 s cron floor) — module headers; [docs/loops.md](../../loops.md) L5-15.
- Built-ins: `green`, `error-sweep`, `docs-sweep` (self-repo chores), `memory-dream` (off), `secretary` (off); earlier `gold-gofmt`, `inbox-delete` — [docs/loops.md](../../loops.md) L17-48; [MVP-PLAN.md](../../../../MVP-PLAN.md) L166.
- Data-driven CRUD: ledger `loop_defs` merged by `effectiveLoops()` each tick; web `/api/loop/{create,update,delete,enable}` admin-gated; `tools/create-loop.ts` uses the same `validateLoopInput → createLoop` path with `promptFile`; checked-in defs in `docs/loops/` (`waselni-store-readiness.json` + `.prompt.md`: daily `0 6 * * *`, judge goal, 30 iterations, $12/fire, `freshSession`) — [docs/loops.md](../../loops.md) L50-71.
- Scheduled fires stream only worker text to the admin chat tagged `#project`; silent when nothing emitted — [docs/loops.md](../../loops.md) L73-82.
- **ADR-0004 gaps (recorded, open):** `runProjectLoop` puts `LoopDef.prompt` into `Order.task` verbatim → no preamble; `loopRunExtras` attaches MCP only for the dream loop → no `ask_operator`/`dispatch`; escalations auto-denied; `runLoop` sums only `iterate()` cost, never the judge run (`loop-runner.ts:54`), so `Bounds.budgetUsd`'s "incl. judge runs" comment is wrong; `judgeGoal` ignores `timeoutMs` (`goal.ts:73`) — [ADR-0004](../../adr/0004-a-loop-prompt-is-a-standing-brief.md); [WIP.md](../../../../WIP.md) L38-42.
- Deferred at design time: event triggers, in-iteration Stop-hook guard, dynamic self-paced intervals — [docs/loops.md](../../loops.md) L14-15.
- Not a loop: the toolchain updater is an engine job on the loop runtime's `isDue` (ADR-0009) — [docs/loops.md](../../loops.md) L162-169.
- **Planned (P1):** `LoopDef.gate` script gate (generalising `dreamGateOutcome`/`secretaryGateOutcome`), script-only loops, silence token, quiet-loop alert, `at` trigger, honest judge budget + daily fire cap, `permission_denials` in the digest, optional `ask_operator` for loops (operator decision 3) — [plan P1](../../superpowers/plans/2026-10-04-neo-research-improvements.md) L356-519. **Planned (dsh E):** `observe` mode for new loops (read-only run, report only) — [dsh note](../2026-11-02-dsh-superagent-and-neo-improvements.md) proposal E.

### Inferences
- Loops are the intended home for proactive/event-driven behaviour (CI reactions, PR babysitting), but today's triggers are time-only; the "action trigger" row in docs/loops.md is unimplemented.

### Gaps
- No ledger figures for loop goal-met rates or iterations-to-green are checked in (the economy-mode guardrail asks for them but no report exists).

---

## 7. Dispatch preamble (`briefWithProjectDocs`): contents and size ceiling

### Takeaway
Every dispatched brief is prefixed by a fixed engine-owned preamble (currently 4,521 chars, test-capped under 5,000) that mandates: read project docs; codebase-memory FIRST with exact `list_projects` names; DESIGN (domain-modeling/codebase-design → CONTEXT.md + ADRs → spec → brainstorming/writing-plans; systematic-debugging for bugs) then BUILD (TDD → verification → code review); the five-item engineering baseline; challenge-yourself before `ask_operator`; no background waits, poll in foreground <90 s, finish in one run; write plans under `docs/superpowers/plans|specs`.

### Cited Findings
- Full text in [src/engine/dispatch.ts](../../../../src/engine/dispatch.ts) L324-392 (`export function briefWithProjectDocs(task)`); applied at L512 with `teamLeadPreamble` when team mode is on.
- Measured length `briefWithProjectDocs("").length` = **4521** (run in this container); the test asserts `< 5000` as "A ceiling, not a target" — [tests/dispatch.test.ts](../../../../tests/dispatch.test.ts) L1296-1298; ADR-0002 recorded growth 3627 → 4311 chars (~1080 tokens) when the baseline was added — [ADR-0002](../../adr/0002-engineering-baseline-lives-in-the-dispatch-preamble.md) L135-137.
- Interactive-only Matt Pocock skills (`grill-with-docs`/`to-spec`/`to-tickets`) are deliberately omitted; a test pins that `domain-modeling`/`codebase-design` are named before `test-driven-development` — [docs/HISTORY.md](../../HISTORY.md) L383-405.
- The preamble applies to dispatch only; interactive turns and loops get none (ADR-0004, ADR-0019 considered options) — [ADR-0019](../../adr/0019-the-engine-registers-and-sends-every-plan.md) L1098-1100.
- Proposed one-line additions (Planned, dsh G/H): restart-recovery note on resumes; before/after Playwright evidence for UI changes "watch the 5000-char ceiling test" — [dsh note](../2026-11-02-dsh-superagent-and-neo-improvements.md) proposals G, H.

### Inferences
- Only ~480 chars of headroom remain under the ceiling; any new preamble rule must displace or compress existing text, or the ceiling must be re-decided explicitly.

### Gaps
- None.

---

## 8. Agent teams, Playwright MCP, toolchain auto-updater (ADR-0009), Codex adapter status and gaps, cross-SDK resume

### Takeaway
Team mode (lead + `backend`/`frontend` subagents via SDK `agents`, coordinating through a contract file) and headless Playwright MCP are Done opt-ins on operator paths; the updater keeps the SDK pin, plugins and MCP servers current deterministically without ever restarting; the Codex adapter works for own-work but runs ungoverned (`workspace-write` + `on-request`, no `canUseTool`/hook mapping) — a recorded P0 spike.

### Cited Findings
- **Agent teams (Done, opt-in):** `src/engine/agent-teams.ts` (80 lines): "Proven GO by spike/agent-team-spike-findings.md — subagents spawn, each subagent's Write/Edit re-enters the session's canUseTool… coordinate through a shared CONTRACT FILE… NOT via SendMessage: the headless SDK does not expose inter-agent messaging" — file header. Codex: unsupported, falls back to single worker with `worker_compat_warning` — [docs/CONFIG.md](../../../CONFIG.md) L217.
- **Playwright MCP (Done):** `playwright-mcp --headless --isolated` attached on both operator call sites in `pipeline.ts`, never ingress; lazy browser launch; still a foreign MCP tool → default-escalate (auto-deny on autonomous paths) — [docs/HISTORY.md](../../HISTORY.md) L261-270.
- **Updater (ADR-0009, Done, restart-gated):** categories `sdk` (bump pin on a worktree branch, tsc+tests green → fast-forward `master`, never touches live install), `plugins` (`claude plugin update` + validate, rollback via `installed_plugins.json`), `mcp` (npm-global playwright-mcp, codebase-memory binary checksum swap, untagged docker images; probe `initialize`+`tools/list`); `holdBreaking` true; never mid-session; never restarts; `/updates` — [ADR-0009](../../adr/0009-the-toolchain-updates-itself-deterministically-and-never-restarts.md); [docs/CONFIG.md](../../../CONFIG.md) L293-326. First real run: SDK 0.3.286→0.3.289 merged, codebase-memory 0.8.1→0.11.0 HELD — [WIP.md](../../../../WIP.md) L161-165.
- **Codex adapter (Partial):** `codexThreadOptions` defaults `sandboxMode: "workspace-write"` (or `read-only` when the judge deny-list is requested) and `approvalPolicy: "on-request"`, `skipGitRepoCheck: true` — [src/engine/session-runner.ts](../../../../src/engine/session-runner.ts) L702-714. Compatibility table: in-process MCP unsupported, `skills`/`maxTurns` dropped, Claude tiers → effort — [docs/CONFIG.md](../../../CONFIG.md) L212-220. Idea map: "Codex runs bypass the governor — Partial… no governor mapping, no proof of what `on-request` does headless → **Keep** → P0 (spike, then fail-closed mapping)" — [idea map](../2026-10-04-neo-research-idea-map.md) L30; plan Task 0.4 proposes `read-only` sandbox + `approvalPolicy:"never"` as the fail-closed default if ungovernable — [plan](../../superpowers/plans/2026-10-04-neo-research-improvements.md) L94-97. Codex gets boundary handoffs only — [ADR-0021](../../adr/0021-context-handoffs-happen-at-boundaries-not-at-thresholds.md) consequences. CLAUDE.md "Next:" names hardening the Codex adapter first.
- **Cross-SDK resume (Done):** see §4; `/sdk claude|codex` switches for new sessions, runtime value persists only via `config.json` — [docs/CONFIG.md](../../../CONFIG.md) L202-204.
- Pins: `@anthropic-ai/claude-agent-sdk` 0.3.289 and `@openai/codex-sdk` 0.145.0 — [plan](../../superpowers/plans/2026-10-04-neo-research-improvements.md) L18-19.

### Inferences
- The Codex path is the single largest compliance/safety hole in own-work today (not in the customer firewall): a Codex worker can write in-workspace without the governor. Any multi-provider proposal must solve governor parity or default Codex to read-only.

### Gaps
- No record of what Codex `approvalPolicy: "on-request"` does headless (the plan's spike is unbuilt).

---

## 9. GitHub integration today: producers/github.ts, git producer, CI/review events back to workers

### Takeaway
GitHub is read-only and operator-facing: a polled `gh --json` scan every 30 min turns PRs, review requests, failed CI, issues and security alerts into attention items; nothing routes a CI or review event back into the worker/session that opened the PR. That routing is the "biggest coding gap" named by the latest research note and is Planned (P5 / dsh proposal B).

### Cited Findings
- `producers/github.ts` kinds: `pr_open`, `pr_review_requested`, `ci_failed` (high, newest completed run per workflow on tracked branches), `issue_open` (assigned or labelled `neo`), `dependabot`, `code_scanning`, `secret_scanning`; failures keep rows; 403/404 = feature off — [src/engine/producers/github.ts](../../../../src/engine/producers/github.ts) L1-55.
- `producers/git.ts` kinds: `unpushed`, `no_upstream`, `dirty`, `stale_branch`, `drift`, `worktree`; per-project config `trackedBranches`, `driftPairs`, `issueLabel`, `ignoreKinds`, `healthUrl`, `deployedVersionUrl` — [src/engine/producers/git.ts](../../../../src/engine/producers/git.ts) L1-25; [docs/CONFIG.md](../../../CONFIG.md) L79.
- All git/gh reads go through `src/engine/git-read.ts` (bounded by `github.callTimeoutMs` 20 s, no prompts, never throws) — file header. Scan every `github.scanEveryMs` 30 min; one `github_scan_error` event per project per hour — [docs/CONFIG.md](../../../CONFIG.md) L78.
- **Webhooks Rejected for now:** "each repo would need a hook and a public endpoint, and polling ~15 repos every 30 minutes… is under 200 API calls an hour" — [ADR-0018](../../adr/0018-attention-items-one-table-many-deterministic-producers.md) considered options.
- **Missing:** "Ticket follows its PR: CI + review comments route to the worker that opened it — Missing — `producers/github.ts` turns PR state into attention items for the operator only; `reply-routing.ts` can resume a folder's session by id → Keep → P5 (research C4), the biggest coding gap" — [dsh note](../2026-11-02-dsh-superagent-and-neo-improvements.md) §2.1 #2. Planned shape: `pr_links` table after settle via `gh pr list --head`, a gated `pr-reactions` built-in loop resuming the linked session with the failing log via `deliverIntoFolder`, escalation after N rounds — [plan P5](../../superpowers/plans/2026-10-04-neo-research-improvements.md) tasks 5.3–5.4; review etiquette rules for the preamble — dsh proposal B.
- Earlier plan (2026-09-06 feature-parity, awaiting approval) also lists a `babysit-prs` loop and a read-only diff pane — [docs/superpowers/plans/2026-09-06-claude-app-feature-parity.md](../../superpowers/plans/2026-09-06-claude-app-feature-parity.md) §2.3/2.4.
- Standing rule: loops never push/deploy; "Operator merges" — [dsh note](../2026-11-02-dsh-superagent-and-neo-improvements.md) "What does not fit Neo" table.

### Inferences
- The engine already has every primitive needed for PR ownership (todo row per brief, `deliverIntoFolder` resume by session id, `gh` reader, attention reconcile); the missing piece is the branch→todo/session binding and a producer that *delivers* instead of only *lists*.

### Gaps
- No `pr_links` or branch-binding data exists in the ledger today, so no history of which session opened which PR can be reconstructed.

---

## 10. Tests / quality: test count, tsc, TDD convention, ADR list, CONTEXT.md glossary, docs/CONFIG.md

### Takeaway
Quality discipline is strict and documented: TDD per task, `tsc` + `bun test` green before "done", 21 ADRs with rejected alternatives, a 610-line glossary, and a 549-line config reference; the recorded suite size grew from 58 (Phase 2) to 1,541 (2026-10-06).

### Cited Findings
- Convention: "Write the failing test first, then the minimal code (TDD). `bunx tsc --noEmit` + `bun test` must be green before any task is 'done.' Commit per logical piece." — [CLAUDE.md](../../../../CLAUDE.md) "How to work here".
- Suite growth recorded in HISTORY: 58 → 82 → 346 → 591 → 630 → 655 → 695 → 730 → 750 → 772 → 813 → 826 → 881 → 929 → 1,541 — [docs/HISTORY.md](../../HISTORY.md) passim; [HANDOFF.md](../../../../HANDOFF.md) L11.
- 122 test files under `tests/` (`find tests -name '*.test.ts' | wc -l`); `bun test` scoped to `tests/` via `bunfig.toml` — [docs/HISTORY.md](../../HISTORY.md) L67-68.
- ADR list (docs/adr/0001–0021): interactive reserve; engineering baseline in preamble; one activity clock; loop prompt is a standing brief; model pinned in config; governor as PreToolUse hook; no dispatch wall clock; durable todo queue; deterministic updater; error containment; trust never lifts fence; out-of-folder writes + approval patience; context window from SDK; bounded console feed; message ids + cause; threads derived; console history paged; attention items; plan registry; auto-memory is project memory; context handoffs at boundaries — `ls docs/adr`. ADR-0015–0020 are "proposed"; 0001–0014, 0021 "accepted".
- Glossary: [CONTEXT.md](../../../../CONTEXT.md) (610 lines) defines ~80 terms with "_Avoid_" synonyms; [docs/CONFIG.md](../../../CONFIG.md) (549 lines) documents every env var and `config.json` knob with env → file → default precedence.
- Commit trailer rule: name the model that actually wrote the commit (the line read "Opus 4.8" long after workers moved on) — [CLAUDE.md](../../../../CLAUDE.md) "Conventions".
- Known flaky/limits recorded: one unreproduced flaky test; `/project` names with spaces; `findByFolder` exact-path match; a failed digest send leaves an empty trace root — [HANDOFF.md](../../../../HANDOFF.md) L24.

### Inferences
- The ADR + CONTEXT.md pair is the repo's decision memory; a report that proposes something an ADR already rejected will be read as re-litigation.

### Gaps
- This container could not run the real suite (no `node_modules`); the 1,541 figure is from HANDOFF, not re-verified here.

---

## 11. Open plans and backlog: idea map P0–P8, dsh proposals A–H, superpowers plans, next-session prompt, HANDOFF, MVP phases 3b/4, CLAUDE.md "Next:"

### Takeaway
The backlog is already triaged into a phased plan (P0–P8, "PLAN ONLY. Waiting for operator approval") plus eight dsh-derived proposals (A–H) mapped onto those phases; MVP Phase 3b (Gemini customer path) and Phase 4 (finance/board) remain deferred; CLAUDE.md's "Next:" names Codex hardening, later context-efficiency phases, then 3b, then 4.

### Cited Findings
- CLAUDE.md "Next:": "harden the Codex SDK adapter… later context-efficiency phases per the 2026-07-23 design spec, then **Phase 3b** (deferred Gemini customer path), then Phase 4 (finance/board)" — [CLAUDE.md](../../../../CLAUDE.md) "Current status".
- Idea map verdict table (Status / Verdict), selected: P0 `/now` steer (Missing/Keep), typed reply answers Allow/Deny (Partial/Keep), Codex governor (Partial/Keep); P1 script gate (Partial), script-only loops (Missing), `at` trigger (Missing), honest loop budget (Partial), `permission_denials` (Partial, SDK 0.3.289 has it); P2 morning brief (Keep), `/memory` (Keep); P3 checks on every dispatch (Partial), rubric grader (Partial), evidence card (Partial); P4 rules table/scoped grants/`/never`/outbound scan (Missing); P5 `/fire/:loop` (Missing), CI/review → session (Missing), loops proposed from chat (Keep); P6 worktree per task (Missing, opt-in, amends ADR-0008), `dispatch_many` (Missing); P7 corrections → skills (Missing); P8 board/departments (Partial on `project_todos`) — [idea map](../2026-10-04-neo-research-idea-map.md) §1–§4.
- Idea map **Defer/Drop**: email-to-task on the customer ingress (Drop — firewall edge), E4 skill curator, E5 bi-temporal facts, E6 repeated work → scripts, H2 prompt evals, prewarm/session tags, full `OperatorHub` refactor, progress card edited in place, ntfy/Push/Slack (Drop — Decisions group is the push channel), voice notes, passkey login, generative UI, focus per operator (Rejected), plan-approval pre-authorisation (Drop), auto-pin (Drop), autonomy auto-promotion (Drop) — [idea map](../2026-10-04-neo-research-idea-map.md) L41-67, L96-112.
- Research-improvements plan: P0 and P1 written as full TDD steps; P2–P8 as task tables; four operator decisions pending (memory on for company; >1 todo per project; `ask_operator` for loops; Codex fail-closed default) — [plan](../../superpowers/plans/2026-10-04-neo-research-improvements.md) L64-97. P3 proposes `.neo/checks.json` + `DispatchEvidence` + judge `DEFICIENCY:` lines; P4 `policy_rules`; P5 `/fire`, `propose_loop`, `pr_links`, `pr-reactions`; P6 `worktrees.ts` reusing `update-sdk.ts` steps, `parallelSlots`, `dispatch_many`; P7 `correction` events, dream proposals, staged skill proposals; P8 goals table, departments-as-config, evening plan/weekly review (own spec first) — L532-606.
- dsh proposals A–H with suggested order "C and G first (prompt-only), then A, then B; E parallel with B; F last; H at the next preamble edit" — [dsh note](../2026-11-02-dsh-superagent-and-neo-improvements.md) §2.2–"Suggested order". One spike: does a headless SDK session get re-invoked when a background Bash task exits? — §2.3.
- Open superpowers plans not executed: `2026-09-06-claude-app-feature-parity.md` (Agent View, per-session SSE, diff pane, `babysit-prs`; Phase E multi-host DEFERRED; "Do not start until the operator approves") and `2026-10-04-neo-research-improvements.md` (PLAN ONLY) — file headers.
- HANDOFF next steps: operator restart to activate P2–P6 (migrations v5→v8, ~250 MB backup); deferred `/attention refresh`; "8 optional extras and the Docker exception need the operator's yes"; push of master is an operator decision; in-flight branches `feat/console-paste-image`, `fix/telegram-stale-callback-answer` — [HANDOFF.md](../../../../HANDOFF.md) L14-26. (In this clone only `master` and the CCR branch exist; those branches are not present here.)
- WIP.md (2026-09-30) lists the "maturing reviewer / adversarial reviewer-gate" as PLANNED, not started — [WIP.md](../../../../WIP.md) L142-146.
- MVP-PLAN: Phase 3b "deferred — own sub-plan"; Phase 4 "Port the rest — web dashboard, finance/reminders, multi-project board" — [MVP-PLAN.md](../../../../MVP-PLAN.md) L188-194. Kickoff prompt for 3b exists — [docs/next-session-prompt.md](../../next-session-prompt.md).
- Deferred at the channel level: WhatsApp/voice customer channels spec exists (`docs/superpowers/specs/2026-06-20-whatsapp-voice-customer-channels.md`), unbuilt.

### Inferences
- The highest-leverage *unbuilt* items by the repo's own ranking are: engine-owned approval board + typed answers + `/now` (P0), verified-done with checks/evidence (P3 / dsh A), PR ownership (P5 / dsh B), and zero-token loop gates (P1). Worktree parallelism (P6) is explicitly gated on an operator decision because ADR-0008 says one todo at a time by operator request.

### Gaps
- Whether the operator has approved any of these plans since 2026-10-06 is not recorded in the repo.

---

## 12. Standing decisions that must not be re-opened

### Takeaway
A fixed set of decisions is marked closed in CLAUDE.md, the ADRs, the specs and the research maps; a report should treat them as constraints.

### Cited Findings
- **Subscription compliance confirmed (Anthropic support 2026-06-20):** personal single-user self-hosted Agent-SDK daemon incl. scheduled/autonomous work is "ordinary individual usage"; "Don't switch to an API key, don't narrow the autonomy on compliance grounds, don't re-open this." The invariant: "Claude never touches clients directly." — [CLAUDE.md](../../../../CLAUDE.md) "Why these decisions".
- **Gemini for customers; customer never on the subscription; never offer customers a Claude login; customer text never reaches a tooled worker** — [CLAUDE.md](../../../../CLAUDE.md) rules; [idea map](../2026-10-04-neo-research-idea-map.md) §6.
- **No credit/overflow accounting (YAGNI); the monthly-credit change is paused** — [CLAUDE.md](../../../../CLAUDE.md).
- **No AI in the engine** — everywhere; ADR-0016 and ADR-0018 each reject an AI summary/triage loop.
- **Autonomy widens only by an operator action; nothing promotes itself; a classifier is never an approval authority** — [plan constraints](../../superpowers/plans/2026-10-04-neo-research-improvements.md) L33-36; [idea map](../2026-10-04-neo-research-idea-map.md) L91, L116.
- **Never restart the daemon without operator permission; restart-gated changes wait** — [ADR-0009](../../adr/0009-the-toolchain-updates-itself-deterministically-and-never-restarts.md); plan constraints L41-42.
- **Worktree folders are temporary; `/home/neo` is the only permanent Neo folder** — [CLAUDE.md](../../../../CLAUDE.md) "Workflow patterns".
- **Trust never lifts the fence (ADR-0011); timeout never = allow (ADR-0012); loops never push/deploy; operator merges** — ADRs cited; [dsh note](../2026-11-02-dsh-superagent-and-neo-improvements.md).
- **One todo at a time per project unless the operator opts in (ADR-0008 → P6 decision)** — [plan](../../superpowers/plans/2026-10-04-neo-research-improvements.md) L89-90.
- **No model downgrade on code-writing paths; no raw-API context betas; no auto-installed MCP/skills; one code-intel MCP** — [spec §8](../../superpowers/specs/2026-07-23-context-efficiency-design.md).
- **Model ids pinned in config, never bare tier aliases (ADR-0005); context window from the SDK, never a code table (ADR-0013)**.
- **Focus is per surface/chat, not per operator; one-shot focus stays** — [idea map](../2026-10-04-neo-research-idea-map.md) L27, L110.
- **The company writes briefs (not a pure router); no dry-run flag on dispatch; no PR-babysitter loop per PR (the owning session handles it)** — [dsh note](../2026-11-02-dsh-superagent-and-neo-improvements.md) §2.2 B/E, §2.4.
- **GitHub webhooks rejected for now in favour of polling** — [ADR-0018](../../adr/0018-attention-items-one-table-many-deterministic-producers.md).
- **Not ported from operant by design:** `screen-manager.ts`, `shim.ts`, `socket-server.ts`, `autopilot.ts`, `autopilot-parser.ts` — [CLAUDE.md](../../../../CLAUDE.md); [MVP-PLAN.md](../../../../MVP-PLAN.md) "Port / build / drop".
- **Machine-local state never touches tracked files** (`.env`, `config.json`, `CLAUDE.local.md`) — [CLAUDE.md](../../../../CLAUDE.md) "Conventions".

### Inferences
- "Observe mode", scoped grants and learned *offers* are the acceptable shapes for autonomy-adjacent proposals; anything that applies a learned rule without a tap is out.

### Gaps
- None.

---

## 13. Known pain points (what has actually gone wrong in production, from HISTORY / ADRs / investigations)

### Takeaway
Production failures cluster in five areas — liveness misreads, silent loss of work, rate-limit and flood storms, governance bypass/stalls, and context mismeasurement — and each produced a corrective ADR or module. Several residual limits are recorded and still open.

### Cited Findings
- **2026-07-22:** Anthropic throttling reported as `subtype:"success"` with `is_error:true`; four sessions' briefs "vanished silently" — [docs/HISTORY.md](../../HISTORY.md) L86-90.
- **2026-07-24:** a scheduled loop whose folder was deleted → `Bun.spawn` ENOENT → uncaught rejection → daemon exit 1 → every in-memory session dropped — L149-160.
- **2026-07-25:** seven live issues: follow-ups delivered only at turn end (still open), stale "waiting Nm" label, dropped/out-of-order Telegram sends, typed reply cannot answer Allow/Deny (still open), non-reply answers hitting the company, backoff parking a worker for hours, queued dispatch interleaving — [docs/investigations/2026-07-25-post-update-issues.md](../../investigations/2026-07-25-post-update-issues.md); status per [idea map §1](../2026-10-04-neo-research-idea-map.md).
- **2026-07-27:** during a long team dispatch every gated tool failed with `Tool permission request failed: Error: Stream closed` — SDK stdin control channel ended with no recovery; engine bridge had no fail-safe — [investigation](../../investigations/2026-07-27-approval-channel-stream-closed.md).
- **2026-09-13:** a waselni worker parked on a background Monitor was stall-aborted twice as if hung; "permission stream" hiccups on hundreds of `gh run view`/`sleep` calls (SDK-side, zero `approval_error` events) — L407-440. Same day: the operator's own `/open` refused "throttled: protecting interactive headroom" while $42.39 of background dispatch spend sat against a $16 allowance — L442-505.
- **2026-09-18:** `sessions` reported `adminli · running · waiting for 10h` for a healthy project (the company offered to restart it); a worker hung ~9 min on `cp -i`; dispatch refused healthy projects as "busy" — [ADR-0003](../../adr/0003-one-activity-clock-one-derived-session-state.md).
- **2026-10-01:** a ~9 h Telegram 429 ban with "nothing in the log and the ledger showing every reply as 'sent'"; tool-step lines were ~86 % of volume — [src/frontends/telegram-flood.ts](../../../../src/frontends/telegram-flood.ts) header; [docs/CONFIG.md](../../../CONFIG.md) L72. Same day: live probe showed project allow rules bypassing the governor (`git push --dry-run` with zero governor calls in `/home/mirshad`) — [ADR-0006](../../adr/0006-the-governor-runs-as-a-pretooluse-hook-first.md).
- **2026-10-04:** eticket-v3 plan run "stopped silently": dispatch closed the input channel at the first `result` while background subagents worked; the next brief was pushed into a closed channel and dropped without a word — [ADR-0007](../../adr/0007-a-dispatch-has-no-wall-clock-and-always-reports-to-its-dispatcher.md). Same audit: three daemon crashes (`database is locked` ×2, port-in-use boot loop), no `bot.catch`, ~15 un-caught sends, inbox-send deadlock — [ADR-0010](../../adr/0010-errors-are-contained-per-unit-and-reported-never-fatal.md).
- **2026-10-05/06:** path fence stalled gold 4 h+ and waselni 7 h on auto-memory/`/tmp` writes, with the watchdog silent because the session was "awaiting-operator" and the digest repeating the same step — [ADR-0012](../../adr/0012-out-of-folder-writes-are-pre-approved-and-approvals-never-wait-forever.md).
- **2026-10-06:** web console froze after 32 h (9,729 events / 3.6 MB replayed per connect, 46–50 s long task); `/api/state` re-parsed 10–37 MB transcripts per poll — [ADR-0014](../../adr/0014-the-console-feed-is-a-bounded-window-resumed-by-event-id.md); L786-794. Context shown 235–306 % for sessions at 47–71 %; 519 `clear` verdicts dropped sessions without a handoff note — [ADR-0013](../../adr/0013-the-context-window-comes-from-the-sdk-not-a-code-table.md). 8 of 47 fresh sessions told to read HANDOFF.md never did — [ADR-0021](../../adr/0021-context-handoffs-happen-at-boundaries-not-at-thresholds.md).
- **Cross-SDK resume:** after `/sdk claude` the company was "permanently stuck, on a healthy API" because its persisted id was a Codex thread id — L196-211.
- **Telegram 4096 drop:** long reports silently dropped; tables broke across chunks; tool results invisible — L226-241.
- **Dispatch false-busy:** a live idle session was reported busy because registry `status` stays `running` for the session's life — L243-259.
- **Answer-in-group flood:** answering a decision in the Decisions group made the project stream all progress there — L335-349.
- **Unclear decision from eticket_prod:** three questions mashed into one `ask_operator` with flat chips → schema-enforced matured decisions — L351-381.
- **Still-open recorded limits:** follow-ups only at turn boundary; typed yes/no cannot answer approvals; Codex ungoverned; loop judge cost uncounted / judge timeout ignored / no `ask_operator` in loops; budget window not persisted across restart; CLI `idle` ignores `run_in_background` Bash; work class captured per launch (a seconds-wide misclassification window); `findByFolder` exact-path; `/project` names with spaces; one flaky test — [idea map §1](../2026-10-04-neo-research-idea-map.md); [ADR-0004](../../adr/0004-a-loop-prompt-is-a-standing-brief.md); [src/engine/budget.ts](../../../../src/engine/budget.ts) L72; [ADR-0007](../../adr/0007-a-dispatch-has-no-wall-clock-and-always-reports-to-its-dispatcher.md) L523-526; [ADR-0001](../../adr/0001-interactive-reserve-gates-background-work-only.md) L97-100; [HANDOFF.md](../../../../HANDOFF.md) L24.

### Inferences
- The recurring root cause across incidents is "several partial signals, no authoritative one" (ADR-0003's phrasing) — the repo's fixes consistently converge on one seam/one function per question. Proposals that add a parallel signal or a second implementation will fit poorly.

### Gaps
- No post-restart verification of the 2026-10-06 batch (ADR-0012–0021) is recorded; HANDOFF's "Try after restart" checklist lives in a gitignored `.superpowers/sdd/` folder not present in this clone.
