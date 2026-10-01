# Claude Agent SDK: new features, and routing models per task

**Date:** 2026-10-01 · **Type:** research only (no code or config changed) · **SDK:**
`@anthropic-ai/claude-agent-sdk@0.3.286` (bundled Claude Code 2.1.286)

**Code baseline.** This doc describes the engine at `c7fc734` (branch
`feat/pin-worker-models-opus-5-5`). That branch adds `config.models`, `CLAUDE_TIER_MODELS`, and
ADR-0005. Those are not on `master` yet. The doc is committed to `dev`, which starts from `master`.

## 1. Summary

- 0.3.286 is the npm `latest` (published 2026-09-30). Neo's SDK notes were checked against 0.3.183,
  and the lockfile was on 0.3.270 before today's pin. This doc compares 0.3.183 and 0.3.270 against
  0.3.286 (the tarballs were unpacked and `sdk.d.ts` was diffed). It also uses the official docs.
- Neo uses about 12 of the roughly 75 `Options` fields. It uses none of the model-control `Query`
  methods (`setModel`, `setPermissionMode`, `supportedModels`, `getContextUsage`). It does not read
  `modelUsage` and does not use SDK hooks.
- **Per-task model routing is fully possible with the SDK as it is.** There are four mechanisms:
  a model per `query()`, a model per subagent, `setModel()` in a live session, and the `plan`
  permission mode. All of them take a pinned model id. Neo already has the single resolution point
  for this (`profileDeps`). What is missing is a **role** key that a path, a loop, or a dispatch
  can choose.
- **Security finding (rank 1).** Allow rules in a project's `.claude/settings.json` auto-approve
  tools *before* `canUseTool` runs. Neo loads `settingSources: ["user","project"]`. So in
  `/home/mirshad`, the rule `Bash(git:*)` approves `git push` without the governor. This is
  documented SDK behaviour. It is not probed live yet (see §4.1).

## 2. How Neo calls the SDK today

| Concern | Where | What it sends |
|---|---|---|
| Base options | `src/engine/session-runner.ts:352` `sdkOptions` | `cwd`, `settingSources:["user","project"]`, `skills:"all"`, `systemPrompt` preset `claude_code`, `permissionMode:"default"`, `includePartialMessages:true`, `canUseTool` |
| Per-run options | `session-runner.ts:730` `runConfig` | `resume`, `effort`, `mcpServers`, `disallowedTools`, `model`, `skills`, `maxTurns`, `agents`, `env` — filtered by the provider's `runConfigFields` |
| Model choice | `src/engine/worker-profile.ts:31` `profileDeps` | `base.model ?? workers.<path>.model ?? models.default`, then alias → pinned id (ADR-0005) |
| Tier pins | `src/engine/model-resolver.ts:89` `CLAUDE_TIER_MODELS` | opus `claude-opus-5-5[1m]`, sonnet `claude-sonnet-5-5`, haiku `claude-haiku-4-5`, fable `claude-fable-5-1` |
| Launch paths | `src/config.ts:62` `WorkerPathName` | `company`, `project`, `dispatch`, `loop`, `judge`, `ingress`, `handoff`, `secretary`. Only `company` and `ingress` set anything (`effort:"low"`). |
| Subagents | `src/engine/agent-teams.ts` | `frontendBackend` team, opt-in via the dispatch tool's `team` field. Both agents use `model:"inherit"`. |
| Governor | `src/engine/governor.ts:48` `decide` | Through `canUseTool` only. `ExitPlanMode`/`EnterPlanMode` are not in `SAFE_TOOLS`, so they escalate as "unrecognized tool". |
| Usage | `src/engine/usage.ts`, `api-retry.ts` | Reads `rate_limit_event` for each window type (including `seven_day_opus` and `seven_day_sonnet`). Reads `total_cost_usd`. Does **not** read `modelUsage`. |
| Live sessions | `startClaudeOrder` | Streaming input (`AsyncIterable<SDKUserMessage>`). This mode is required for `setModel` and `setPermissionMode`. |

## 3. What is new, and what Neo does not use

### 3.1 `Options` fields added after 0.3.183 (the version Neo's notes were checked on)

| Field | What it does | Use for Neo |
|---|---|---|
| `projectConfigRoot` | Loads project settings, `.mcp.json` and `.claude/*` from the trusted checkout, not from the worktree in `cwd` | Medium. Worktree-per-agent dispatch can get settings from the main checkout. A branch then cannot change its own hooks or permissions. |
| `permissionPrompts: 'host' \| 'none'` | `'none'` means `canUseTool` is never called, and anything that would prompt is denied | High for autonomous paths (loops, judge). An escalation becomes a hard deny that the SDK enforces. Today Neo does this itself. |
| `verbatimPrompts` | Sends the prompt without `@path` expansion, slash-command dispatch or the turn-start attachment pass | Low. Possible use for tainted briefs. Note that it also skips CLAUDE.md on the first turn. |
| `resumeDropsTurn` | Fork or resume that drops a turn | Low |
| `pluginDelivery: 'initialize'` | Sends the plugin list over stdin, not argv | Low (Linux) |
| `perTaskStopAffordance` | An interrupt stops only the turn, not the background subagents | Medium, if team runs grow |

**Behaviour change in 0.3.286:** "Before TypeScript Agent SDK v0.3.286, omitting `permissionMode`
was the same as passing `default`." Now the start mode can come from settings, and the default can
be **auto mode**. Neo always passes `permissionMode:"default"` (`session-runner.ts:366`), so Neo is
safe. This line must stay. Add a test that pins it (see §5, item 9).

### 3.2 `Options` fields that existed already but Neo does not use

| Field | Notes |
|---|---|
| `fallbackModel` | A comma-separated chain. It is tried when the primary is overloaded or unavailable. The primary is tried again at the start of each user turn. |
| `thinking`, `maxThinkingTokens` | `{type:'adaptive'}` is the default on current models. `maxThinkingTokens` is deprecated. |
| `effort` values | `low \| medium \| high \| xhigh \| max`. **Opus 5.5 and Sonnet 5.5 default to `medium`.** Neo sets no effort for project or dispatch work, so they run at `medium`. |
| `maxBudgetUsd` | Ends the query with `error_max_budget_usd`. It also refuses new subagents and stops background ones. Cost is a client-side estimate. |
| `taskBudget` (alpha) | A token budget that the model can see, so it can pace itself |
| `outputFormat: {type:'json_schema', schema}` | Structured output. The result carries `structured_output`. The subtype `error_max_structured_output_retries` exists. |
| `forkSession`, `resumeSessionAt`, `sessionId` | Fork a session into a new id. Branch from a known turn. |
| `enableFileCheckpointing` + `Query.rewindFiles()` | Revert files to a checkpoint at a user message |
| `hooks` (33 events) | See §3.4 |
| `agent` | Runs the **main thread** as a named agent definition |
| `agentProgressSummaries`, `forwardSubagentText` | Progress lines for subagents (`task_progress.summary`), and a nested transcript |
| `planModeInstructions` | Replaces the plan-mode workflow body |
| `persistSession:false`, `sessionStore` (alpha) | No transcript on disk, or a mirror to an external store |
| `allowedTools` | Pre-approval. **Neo must not use it**, because a bare entry bypasses `canUseTool`. |

### 3.3 `Query` methods (on the object `query()` returns)

`setModel(model?)`, `setPermissionMode(mode)`, `setMaxThinkingTokens`, `applyFlagSettings`
("`model` applies immediately"), `supportedModels()` (returns `ModelInfo` with
`supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsAutoMode`), `getContextUsage()`
(a token breakdown by category, skill and tool), `accountInfo()`, `initializationResult()`,
`stopTask(id)`, `backgroundTasks()`, `rewindFiles()`, `setMcpServers()`, `toggleMcpServer()`,
`reloadSkills()`, `reloadPlugins()`. Neo uses only `interrupt()`.

### 3.4 Hooks

`HOOK_EVENTS` in 0.3.286: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
`UserPromptSubmit`, `SessionStart/End`, `Stop`, `StopFailure`, `SubagentStart/Stop`,
`PreCompact/PostCompact`, **`PreModelSwitch/PostModelSwitch`**, `PermissionRequest`,
`PermissionDenied`, `TaskCreated/Completed`, `InstructionsLoaded`, `FileChanged`, `CwdChanged`,
`WorktreeCreate/Remove`, and more.

- **`PreToolUse` runs before the allow and deny rules.** A hook deny applies in every mode. This
  is the fix for §4.1.
- **`PostModelSwitch`** reports `from_model`, `to_model`, `requested_model`,
  `source: command|picker|sdk|auto|resume`, `context_tokens`, `prompt_cache_warm` and
  `estimated_cache_write_usd`. With it the engine can **record every model change**, including
  changes Neo did not ask for (`source:"auto"`: overload fallback or the content classifier).

### 3.5 Message types Neo ignores

Neo handles `assistant`, `result`, `system`, `stream_event` and `rate_limit_event`. The union also
has `SDKModelRefusalFallbackMessage` and `SDKModelRefusalNoFallbackMessage`, `SDKAPIRetryMessage`,
`SDKCompactBoundaryMessage`, `SDKTaskStarted/Progress/Notification`, `SDKPermissionDeniedMessage`,
`SDKConversationResetMessage`, `SDKToolUseSummaryMessage`, and `SDKMemoryRecallMessage`.

### 3.6 `AgentDefinition` (subagents)

`description`, `prompt`, `tools`, `disallowedTools`, **`model`** (an alias, a full id, or
`'inherit'`), `mcpServers`, `skills`, `maxTurns`, `background`, **`effort`**, `permissionMode`,
`omitClaudeMd` (0.3.271+), `memory`, `initialPrompt`, and the experimental `observer`.
Model precedence for a subagent: the per-call model parameter, then `AgentDefinition.model`, then
the `CLAUDE_CODE_SUBAGENT_MODEL` env var, then the session model. "Subagents keep their own model
even if parent switches."

Limits (env): `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3) and
`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20). Plus `maxBudgetUsd`. The docs say: "Claude
Opus 5 delegates to subagents more readily than earlier models". The `claude_code` preset adds a
"don't call Agent unless asked" line, but only "when the model is Opus 5".

## 4. Findings that change risk

### 4.1 Settings-file allow rules bypass the governor (not yet probed live)

The permissions doc gives the order: hooks → deny rules → ask rules → permission mode → **allow
rules** → `canUseTool`. It also says: "Auto-approved tools never reach `canUseTool`… allow rules
coming from settings files aren't visible to the [shadowing] check." Neo loads
`settingSources:["user","project"]`, so each project's `.claude/settings.json` applies:

- `/home/mirshad/.claude/settings.json` allows `Bash(git:*)` and `Bash(docker:*)`. So
  `git push --force` and `docker rm` would run in a mirshad dispatch, and `RISKY_BASH` would never
  see them.
- `/home/adminli.archive` and `/home/new` have the same rules.
- `defaultMode: acceptEdits` in those files is overridden, because Neo passes
  `permissionMode:"default"`.

`settings.local.json` files are not loaded, because the `local` source is not in
`settingSources`.

**Fix:** move `decide()` into a `PreToolUse` hook. The hook runs first, and its deny wins in every
mode. Keep `canUseTool` as the escalation surface, or let the hook await the operator itself. A
live probe should confirm the bypass first: dispatch `git status && git push --dry-run` into a
scratch folder with `Bash(git:*)` in `.claude/settings.json`, and check whether the governor sees
the call.

### 4.2 The model can change under Neo without a record

- Overload fallback (`fallbackModel`, when set) and the **content classifier**: "Fable 5.1 /
  Opus 5.5: cybersecurity-flagged → re-run on Opus 4.8; biology-flagged → Opus 5." Also "after a
  fallback, the session continues on the fallback model." eticket and IA NDC security work can be
  flagged as cyber.
- `message.model` drops the `[1m]` tag (see `docs/sdk-notes.md`).
- So ADR-0005's "the engine can say which model did a piece of work" is true for the **request**,
  but not for the **execution**. `result.modelUsage` (keyed by model, with `costUSD`,
  `contextWindow` and `canonicalModel`) plus the `PostModelSwitch` hook close this gap.

### 4.3 Subscription and limits for each model

- `SDKRateLimitInfo.rateLimitType` has `five_hour`, `seven_day`, **`seven_day_opus`**,
  **`seven_day_sonnet`**, `seven_day_overage_included` and `overage`. So the server *can* report a
  separate weekly window for Opus and for Sonnet. `usage.ts` already stores the latest event per
  window type.
- Anthropic does not publish fixed numbers for each model on Max. The official model-config page
  says only: "Depending on your plan and seat tier, **Fable usage can bill to usage credits**
  instead of drawing on your plan's included limits… In interactive sessions, Claude Code shows a
  consent prompt." A headless SDK run has no prompt. So it is **not known** whether a Fable worker
  draws from the plan, bills credits silently, or fails. Third-party sources say Max includes Fable
  up to 50% of weekly usage. This is not verified. (CLAUDE.md says: do not build credit
  accounting. This is about *not spending* credits by accident, not about accounting for them.)
- The 2026-10-01 live probe accepted `claude-fable-5-1` (`docs/sdk-notes.md`). That proves the id
  is valid. It does not prove the billing path.

### 4.4 Cost fields are estimates

`total_cost_usd` and `costUSD` are computed on the client from a price table bundled with the SDK.
On a subscription they are a *usage proxy*, not a bill. That is fine for `maxBudgetUsd` as a
runaway cap. `modelUsage` counts subagents, but `usage` does not.

## 5. Ranked improvements

Value and risk use H/M/L. Effort is in engine-days (TDD included).

| # | Improvement | Value | Effort | Risk | Files |
|---|---|---|---|---|---|
| 1 | **Governor as a `PreToolUse` hook** (fixes §4.1). Keep `canUseTool` for escalation answers. Probe live first. | H (security) | 1–2 | M: escalation must still reach the operator; hook timeouts | `session-runner.ts` (`sdkOptions`), `governor.ts`, `tests/governor*.test.ts` |
| 2 | **Model roles** (`plan` / `execute` / `simple`) in `config.models.roles`. A role can be chosen per path profile, per loop def and per dispatch call (§6). | H (cost and quality control) | 2 | L: additive; default role = today's model | `config.ts`, `worker-profile.ts`, `model-resolver.ts`, `dispatch.ts` (tool schema + `DispatchDeps`), `loop-validate.ts`, `loops.ts`, `tools/create-loop.ts`, `docs/CONFIG.md`, ADR-0006 |
| 3 | **Record what really ran**: read `result.modelUsage`, handle `PostModelSwitch` and the refusal-fallback messages, and write them to the ledger. Show them on the dashboard. | H (makes 2 verifiable; fixes §4.2) | 1 | L: read-only | `session-runner.ts` (`consumeStream`, hooks), `ledger.ts`, `usage.ts`, `dashboard.ts` |
| 4 | **Plan → execute dispatch** (`phases:"plan-execute"`): the plan run uses the `plan` role in `permissionMode:"plan"` with `outputFormat`. The execute run uses the `execute` role with the plan in the brief (§6.3). | H for big builds | 2–3 | M: two runs, longer wall time, stall monitor | `dispatch.ts`, `session-runner.ts` (`permissionMode` + `outputFormat` in `runConfig`), `governor.ts` (`ExitPlanMode` policy) |
| 5 | **`fallbackModel` chain from config** (`models.fallback`, pinned ids). Fewer `overloaded` give-ups than Neo's own retry ladder. | M | 0.5 | L, if #3 records the switch | `model-resolver.ts` (`runConfigFields`), `worker-profile.ts`, `config.ts` |
| 6 | **Explicit `effort` for each role.** Today project and dispatch work runs at Opus 5.5's default `medium`. Set `execute: high` on purpose, or leave it on purpose. | M | 0.5 | L | `config.ts` (`workers`/roles) |
| 7 | **Subagent model policy**: `workerEnv.CLAUDE_CODE_SUBAGENT_MODEL` (the `simple` id) for ad-hoc `Agent` calls, and depth/concurrency caps through `workerEnv`. Team agents keep `inherit`, or take a role. **Config-only for the env part.** | M | 0.25 (config) / 0.5 (team role) | L. Note: Opus 5 delegates readily, so cheap subagents save a lot. | `config.json`, `agent-teams.ts` |
| 8 | **Structured output for the judge** (`outputFormat` `{met:boolean, reason:string}`). This replaces parsing the strict last line. | M (fewer false "not met") | 1 | L: fall back to the last-line parse | `goal.ts`, `loops.ts`, `session-runner.ts` |
| 9 | **Guard the 0.3.286 default change**: a test that asserts `permissionMode:"default"` is always sent. Also consider `permissionPrompts:"none"` for autonomous paths. | M | 0.25 | L | `tests/session-runner*.test.ts`, `loops.ts` |
| 10 | **`maxBudgetUsd` per loop fire or dispatch** as a runaway cap (it also stops subagent sprawl) | M | 0.5 | L: an estimate, so set it generously | `worker-profile.ts`, `loops.ts`, `dispatch.ts` |
| 11 | `getContextUsage()` / `modelUsage[m].contextWindow` to feed `context-policy` the real window. This settles ADR-0005's deferred item (the `[1m]` window is known from `contextWindow`, not from the transcript). | M | 1 | M: changes handoff timing about 5x (ADR-0005) | `context-policy.ts`, `session-runner.ts` |
| 12 | `projectConfigRoot` for worktree-isolated dispatch; `forkSession` for "try a variant" runs; `enableFileCheckpointing` for revert | L–M | 1 each | L | `dispatch.ts`, `session-runner.ts` |

**Top 3:** #1 (close the governor bypass), #2+#3 together (roles, and a record of what really ran),
and #4 (plan with one model, execute with another).

## 6. Model-routing design

### 6.1 Question and answer

> Can one session or dispatch plan with Fable, run the work with Opus, and send simple tasks to
> Sonnet?

**Yes**, with the SDK as it is. The best mechanism is **two `query()` runs, each with its own pinned
`model`, chosen by role from config**. This works for both one-shot and live sessions. `opusplan` is
not suitable:

| Mechanism | Works? | Verdict for Neo |
|---|---|---|
| `model` per `query()` | Yes. Neo already sends it (`runConfig`). | **Primary.** Deterministic, recorded, testable. |
| `AgentDefinition.model` per subagent | Yes. Precedence is shown in §3.6. | **For "simple" subtasks inside one run.** The AI decides *when* to delegate, and the engine fixes *which model* runs it. |
| `CLAUDE_CODE_SUBAGENT_MODEL` env | Yes, through `workerEnv`. No code needed. | Default for ad-hoc `Agent` calls. |
| `Query.setModel()` in a live session | Yes, in streaming input mode. Neo's `startOrder` uses it. | For a live session that changes phase. It **loses the prompt cache** (the cache is per model; `PostModelSwitch.estimated_cache_write_usd` shows the cost). |
| `resume` with a different `model` | Yes (the model is an option of each query) | Possible, but it re-sends the whole history uncached to the new model. A clean brief with the plan in it is cheaper and clearer. |
| `opusplan` alias | Only Opus → Sonnet. Fable is not possible. | **Rejected.** It is release- and settings-dependent and cannot be pinned (ADR-0005). It is also the wrong pair. |
| `permissionMode:"plan"` → `setPermissionMode("default")` | Yes | This is how the plan phase is enforced as read-only. Edits go to `canUseTool` in plan mode. |

### 6.2 Roles: a deterministic choice, with no AI in the engine

```jsonc
// config.json (proposed)
"models": {
  "default": "claude-opus-5-5[1m]",          // unchanged; = role "execute"
  "aliases": { "...": "..." },               // unchanged
  "roles": {
    "plan":    { "model": "claude-fable-5-1",    "effort": "high" },
    "execute": { "model": "claude-opus-5-5[1m]", "effort": "high" },
    "simple":  { "model": "claude-sonnet-5-5",   "effort": "low"  }
  },
  "fallback": ["claude-opus-5-5", "claude-sonnet-5-5"]   // item #5
}
```

Who chooses the role:

1. **Path profile:** `workers.<path>.role`. Proposed defaults: `company`/`ingress` → `simple`;
   `judge`/`handoff` → `simple`; `project`/`dispatch`/`loop` → `execute`; `secretary` → `plan`
   (it reviews and decides). This is pure config.
2. **Loop definition:** an optional `role` field, validated by `loop-validate.ts` and written by
   `tools/create-loop.ts`. Example: `waselni-store-readiness` → `simple`.
3. **Dispatch call:** the `dispatch` tool takes a **closed enum** `role?: "plan" | "execute" |
   "simple"` and `phases?: "plan-execute"`. This uses the same shape as the existing `team` enum.
   The *calling worker* (AI) picks from a fixed menu. The *engine* maps the role to a pinned id and
   records it. The engine never inspects the brief to guess. This follows "AI decides, the engine
   acts and governs".

The resolution order extends ADR-0005 and keeps one resolution point in `profileDeps`: an explicit
`RunDeps.model` wins, then the role (call → loop → path), then `workers.<path>.model`, then
`models.default`, then alias expansion. An explicit `effort` wins over the role's effort.

### 6.3 Plan → execute flow (`phases:"plan-execute"`)

1. **Plan run.** Use `role:plan`, `permissionMode:"plan"`, and
   `outputFormat: {type:"json_schema", schema:{plan, steps[], risks[], open_questions[]}}`.
   Use the same `cwd` and the same governor. Write tools are denied by the plan mode, and the
   governor still fences them.
2. **Engine gate (deterministic):** `structured_output` must be present and must match the schema.
   If `open_questions` is not empty, raise it through the existing ask-operator path and stop. If
   the run ends with `error_max_structured_output_retries`, fail the dispatch with that reason.
3. **Execute run.** Start a fresh `query()` with `role:execute`. The brief is the original task
   plus the approved plan. It is fresh, not a resume, so that the cache cost and context are clean.
4. **Simple subtasks.** Inside the execute run, ad-hoc `Agent` calls use the `simple` id
   (`CLAUDE_CODE_SUBAGENT_MODEL`). Named team agents use their own role.
5. **Record.** Each run writes `{role, requestedModel, modelUsage, switches[]}` to the ledger
   (item #3).

### 6.4 Acceptance criteria (for the later build)

- A path with `role` and no `model` launches with the role's pinned id and effort. A test drives a
  real dispatch and reads `RunDeps` (same guard as ADR-0005).
- Dispatch `role:"simple"` → `claude-sonnet-5-5`. An absent role → `models.default` (no behaviour
  change).
- An unknown role in config or a loop def is rejected at validation. It does not fall back
  silently.
- On Codex, a role maps to an effort only. The existing rule applies: no Claude id reaches Codex.
- `plan-execute`: the plan run is sent with `permissionMode:"plan"` and `outputFormat`. The execute
  run starts only after the plan passes the gate. Two ledger rows share the order id.
- A `PostModelSwitch` with `source:"auto"` is recorded as `worker_model_switched`. The run is not
  failed.

### 6.5 Edge cases

- **Fable billing (§4.3):** if Fable bills credits, the `plan` role must fall back to Opus. Read
  `supportedModels()` at startup to see this. Decision Q1.
- **Content classifier** moves cyber-flagged work from Opus/Fable to Opus 4.8. Record it; do not
  fight it. Turning it off (`switchModelsOnFlag:false`) turns the switch into a refusal.
- **`[1m]` on the plan role:** Fable `[1m]` is valid syntax. Use it only if planning reads very big
  code bases.
- **Interactive reserve and budget:** each phase is a separate run, and the budget meter must count
  both. `workClass` follows the original trigger (no change).
- **Stall monitor:** the plan run in plan mode streams events like any run. No new risk.

## 7. Open questions for the operator

1. **Fable on your Max plan:** do you accept that a Fable planning run *may* bill usage credits
   (the docs say "depending on plan and seat tier")? Or must `plan` fall back to Opus when Fable is
   marked "Requires usage credits"? Recommendation: fall back, until one supervised probe shows the
   billing path.
2. **Default roles per path** (§6.2 item 1). The biggest saving is `company`/`ingress`/`judge` →
   Sonnet. Does chief-of-staff routing on Sonnet meet your quality bar?
3. **Effort for `execute`:** leave it at Opus 5.5's default `medium`, or set `high` on purpose for
   project work? This trades quality against subscription burn.
4. **Plan gate:** must every `plan-execute` plan wait for your approval, or only plans that have
   `open_questions`?
5. **Governor fix (#1):** may a worker run one live probe to confirm the settings-file bypass, in a
   scratch folder with `--dry-run` only?

## 8. Sources

- Installed types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (0.3.286, 9,890 lines),
  `sdk-tools.d.ts`. Diffed against 0.3.183 (6,535 lines) and 0.3.270 (9,221 lines), from
  `npm pack`.
- Bundle model list: `claude-agent-sdk-linux-x64/claude` (aliases `sonnet, opus, haiku, fable,
  best, sonnet[1m], opus[1m], fable[1m], opusplan`; ids as in `docs/sdk-notes.md`).
- Docs: [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript),
  [Model configuration](https://code.claude.com/docs/en/model-config),
  [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents),
  [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions),
  [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking).
- Unverified third-party (plan limits only):
  [codersera — Fable usage credits](https://codersera.com/blog/claude-fable-5-usage-credits-july-2026/),
  [morphllm — usage limits](https://www.morphllm.com/claude-code-usage-limits).
- Neo: `docs/sdk-notes.md`, ADR-0005, `docs/CONFIG.md` "Worker models".
