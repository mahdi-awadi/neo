---
approval: required
---
# Agents Ask and Tell Each Other — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker can ask the main agent or another project's agent for a fact, a shared tool, or
how to do something. It gets the answer back into its tool call. The main agent can give
information to a running worker without starting work. Shared keys reach no worker: they go through
the ADR-0044 catalogue and relay.

**Architecture:**
- One deep module, `src/engine/agent-post.ts` (`createAgentPost → { ask, tell, take, sweep }`), sits
  behind three seams: `AgentPostLedger`, `ConsultRunner` and `TargetResolver`.
- Asks are answered by read-only **consult runs** that fork the target's latest session.
- Held messages reach a running worker only at **delivery points**: the PostToolUse
  `additionalContext`, or the start of its next turn.
- Resources reuse ADR-0044 (catalogue, `tools_for`, `tool_api`), which this plan builds first, plus a
  scrub of the worker environment.

**Tech Stack:** Bun 1.3 + TypeScript, `@anthropic-ai/claude-agent-sdk` (`forkSession`, PostToolUse
hooks), `bun:sqlite` (ledger migration v13), zod, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-agent-ask-and-tell-design.md` (ADR-0050).
**Also builds:** `docs/superpowers/plans/2026-10-22-tools-catalogue.md` Phases 1–2 (ADR-0044 + Amendment 1).

## Global Constraints

- **No AI in the engine.**
  - The engine guards, records, routes, frames and delivers. Workers do all answering.
  - Tool search is BM25 (ADR-0044).
- **Fail closed and stay bounded.**
  - Every `config.agents` value falls back to the spec §8 default (the `readNotesCfg` pattern).
  - Each refusal names its rule and starts no run.
- **No secrets anywhere.**
  - A secret value never goes into a row, event, line, reply, frame or log.
  - Questions, answers and tells are checked with `findSecret` from `src/engine/secret-patterns.ts`.
- **Gates.**
  - `ask_agent` goes to operator workers only. `tell_agent` goes to the company only.
  - Neither tool goes to ingress, tainted, consult, loop or Codex runs.
  - The delivery hook is never installed on tainted or consult runs.
- **A tell is never a brief.**
  - Nothing in this plan calls `followUp` to start a turn for a held message.
  - Nothing in this plan adds a todo.
- **Reuse, don't duplicate:**
  - `project_notes` is the fallback (`createProjectNotes` send path).
  - `registry.noteBlocked` holds the stall clock.
  - `trace.outbound` writes lines; `ledger.recordEvent` writes events; `countEvents` comes from ADR-0044 P1.4.
  - `heldByReserve` checks the reserve. The `resumeMissing` fresh-start path exists already.
  - Use `worker-profile.ts` per-path profiles, the governor hook registration site (ADR-0006), and
    the ingress strip pattern (`notes: undefined`).
- **i18n:** console strings use `locales/{en,ar}/console.json` (namespace `agents.*`), AR+EN
  complete. Numbers and refs are LTR isolates.
- **Where to work.**
  - Use the worktree `/home/neo-agent-messaging` on branch `feat/agent-messaging`, made from `dev`
    with `feat/tools-catalogue` merged.
  - Merge a phase to `dev` only when it is green.
- **What not to do.**
  - Never merge to master or restart.
  - Never run `tools/catalogue/install.ts` on the real `~/.claude`.
  - Never open the live ledger with this code.
- **Every task ends green:** `bunx tsc --noEmit` and `bun test <its tests>`. Each phase ends with a
  full `bun test`.
- **Commits** use `git commit -F <file>` and end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Preamble:** `briefWithProjectDocs` stays under its 5000-char test cap (4978 today). Reword the
  text; never append.

## Review Focus

1. **A worker asks another agent to do work** ("fix X in your repo"). Expected: the consult run
   cannot write and answers "needs work, file a project_notes request". Pinned in T9 (consult
   profile) and T8 (frame text).
2. **The asker's run ends before a late answer.** Expected: the row stays held for the folder, and
   the next session of that folder gets it once. Pinned in T7 (`take` by folder).
3. **The daemon reloads mid-consult.** Expected: on start-up the row becomes `failed (reload)`, and
   the asker gets the failure at its next delivery point, never a hang. Pinned in T7 (`sweep` on boot).
4. **A tell or a late answer is bigger than `deliverMaxChars`, or many are held at once.** Expected:
   rows are delivered in order, up to the cap, and the rest wait for the next point; none is lost or
   repeated. Pinned in T7 (`take` cap).
5. **The main agent pastes a key into a tell or an answer.** Expected: a refusal (tell) or the
   withheld line (answer), and the sentinel appears nowhere. Pinned in T7 and T8.

---

## Phase 0 — SDK spike (throwaway, ~30 min)

### Task 0: Prove the two SDK behaviours the design rests on
**Files:** `spike/agent-post-probe.ts` (not imported by `src/`); the findings go in `docs/sdk-notes.md`.
- [ ] Step 1: In a temp folder (`mktemp -d`), start a streaming-input Claude run with a PostToolUse
  hook that returns `additionalContext: "PROBE-7731: reply with this code"` after the first tool
  call. Prompt: "list this folder, then say what you were told". Record whether the text reaches the
  model in the same turn.
- [ ] Step 2: While a first run is mid-turn on session S, start a second `query` with
  `resume: S, forkSession: true` and ask "what was the last file you listed?". Record that it
  answers from S's history, gets a new session id, and that S's run is unaffected.
- [ ] Step 2b: Repeat step 2 while S is mid-tool-call (an open `tool_use`). Record the result only:
  the plan forks only idle targets either way.
- [ ] Step 3: Write both results, with the SDK version, in `docs/sdk-notes.md` and commit
  `docs(sdk): PostToolUse additionalContext and forkSession beside a live run (ADR-0050, P0)`.
  **If either fails, stop and report.** Then §5 falls back to turn start only, or §2.4 to fresh only,
  and the plan is re-sent.

## Phase 1 — tools catalogue, relay, env scrub (ADR-0044 P1)

### Tasks 1–4: ADR-0044 Phase 1, exactly as `2026-10-22-tools-catalogue.md` Tasks 1–4
Cards and the validator, the first cards, skill rendering and install, and the `tool_api` relay with
`countEvents`. These are built verbatim from that plan, including its tests and commit messages. The
`DispatchDeps.tools?: Catalogue` dep and `ledger.countEvents({kind, folder, since})` that they
produce are used below.

### Task 5: Scrub the worker environment
**Files:**
- Create: `src/engine/worker-env.ts`, `tests/worker-env.test.ts`
- Modify: `src/config.ts` (`loadDotEnv` returns the key names it set; `agents.workerEnv` reader), `src/engine/session-runner.ts:726` (`mergedSdkEnv`), `src/daemon.ts` (pass `engineKeys` + relay keys; record the report once)

**Interfaces:**
- Produces: `scrubWorkerEnv(env: Record<string,string>, o: { engineKeys: ReadonlySet<string>; relayKeys: ReadonlySet<string>; inherit: ReadonlySet<string>; mode: "report" | "strip" }): { env: Record<string,string>; stripped: string[]; reported: string[] }`; `RunDeps.envScrub?: Omit<Parameters<typeof scrubWorkerEnv>[1], never>`.

- [ ] Step 1: failing tests in `tests/worker-env.test.ts`:
  - `relay keys go in both modes`: `{SCALEDOWN_API_KEY:"SENTINEL-v"}` + relayKeys → absent.
  - `report keeps engine keys and lists names`: `reported` equals the engine key names, and `env` keeps them.
  - `strip removes engine keys except inherit`: `CLAUDE_CODE_OAUTH_TOKEN` in `inherit` stays.
  - `values never in the result lists`: `JSON.stringify({stripped, reported})` has no `SENTINEL`.
  - `mergedSdkEnv applies the scrub`: through `runConfig` with a fake env.
  - `loadDotEnv returns only the names it set`: a key already in `process.env` is not in the list.
- [ ] Step 2: `bun test tests/worker-env.test.ts` → FAIL.
- [ ] Step 3: Implement it (pure). Then in `daemon.ts`, record `worker_env_report {names}` once per
  start when `mode` is `report` and the list is not empty.
- [ ] Step 4: The test, `tests/session-runner*.test.ts` and `bunx tsc --noEmit` → PASS.
- [ ] Step 5: Commit `fix(security): workers never inherit engine-held keys; report or strip Neo's .env keys (ADR-0050 §4, P1.5)`. Full `bun test`. **Merge P1 → dev.**

## Phase 2 — tool search, `tools_for`, hint (ADR-0044 P2)

### Tasks 6a–6c: ADR-0044 Phase 2, exactly as `2026-10-22-tools-catalogue.md` Tasks 5–7
The `safeFtsQuery` any-word mode, `openCatalogue` + `find`, and `tools_for` + the tools hint. They
produce `Catalogue.find(text, {project, folder, limit}) → ToolMatch[]`, which is used in Task 8.
Their preamble sentence is merged into the one T11 writes, so the cap is measured once. **Merge P2 → dev.**

## Phase 3 — the agent post (core, no SDK)

### Task 7: Ledger table + `createAgentPost` (`ask` with a fake consult, `tell`, `take`, `sweep`)
**Files:**
- Create: `src/engine/agent-post.ts`, `tests/agent-post.test.ts`, `tests/agent-post-ledger.test.ts`
- Modify: `src/engine/ledger-migrations.ts` (v13 `agent messages`), `src/engine/ledger.ts` (row API), `src/engine/liveness.ts:36` (`kind: "approval" | "decision" | "agent"`), `src/config.ts` (`agents: readAgentsCfg(fileCfg.agents)`), `docs/CONFIG.md` (`agents` rows, spec §8)

**Interfaces:**
- Produces (ledger):
  - Row type `AgentMessage { id; kind: "ask"|"answer"|"tell"; fromProject; fromFolder; fromOrder?; fromSession?; toProject; toFolder; toSession?; need?; text; status: "answering"|"answered"|"held"|"delivered"|"failed"|"refused"|"expired"; replyTo?; causeMsgId?; threadId?; depth; chain: string[]; createdAt; answeredAt?; deliveredAt? }`.
  - `ledger.addAgentMessage(m: Omit<AgentMessage,"id">): string`, `ledger.setAgentMessage(id, patch)`.
  - `ledger.heldFor(folder: string, sessionId: string, liveSession: (id: string) => boolean): AgentMessage[]` (created order). It applies the spec §2 "who takes" rule. `ledger.markDelivered(ids: string[], at: number)` runs in one transaction.
  - `ledger.agentCounts({fromOrder?, fromProject?, pair?: [from,to], toProject?, kind, since}): number`, with parameterized SQL.
- Produces (module): `createAgentPost`, `AgentPost`, `Caller`, `Need`, `ConsultRunner`, `TargetResolver = (to: string, from: Caller) => { folder; name; lastSession?: { id; sdk: "claude"|"codex"; occupancyPct?: number } } | undefined`, `AgentsCfg`, `DEFAULT_AGENTS_CFG`, `readAgentsCfg(raw)`, `checkAsk(...)`, `frameHeld(rows): string`. All exactly as in spec §1, §2 and §8.

- [ ] Step 1: Failing ledger tests (`tests/agent-post-ledger.test.ts`):
  - v12 → v13 on a temp copy creates `agent_messages` plus the indexes `(to_folder,status)` and `(from_order,created_at)`.
  - `heldFor` returns rows in created order, for that folder only.
  - `markDelivered` is atomic.
  - `agentCounts` ignores rows older than `since`.
- [ ] Step 2: Failing module tests (`tests/agent-post.test.ts`), with a fake consult, a fake clock, a
  fake resolver and a spy trace:
  - `refuses each guard`: one `it` per spec §2.1 rule (disabled, unknown target, self, blank, long,
    secret, depth, chain, open pair, per order, background per order, per project at 23 h vs 25 h,
    concurrency, background reserve). Each asserts `consult` was not called and the reply contains
    the rule name.
  - `good ask records, traces, consults once`: 1 row, 1 `agent_ask` event whose data has no question
    text, 1 `trace.outbound` with the asker's cause and kind `notice`, and the consult `folder` = the
    target folder.
  - `fork vs fresh`: `forkFrom` is set for an idle claude session at 40 %. It is unset at 70 %, for
    a session in a turn, for a codex session, and with no session.
  - `who takes`: a held answer with a live `to_session` is not given to another session of the same
    folder. After that session ends, the other session takes it once. Two `take` calls on one row
    deliver it once.
  - `answer in time`: the reply equals the answer, the row is `answered`, and there is 1 `agent_answer` event.
  - `secret answer is withheld`: the consult returns `"key SENTINEL-sk_live_…"`. The reply is the
    withheld line, and `SENTINEL` is in no row, event, line or reply.
  - `late answer`: the clock passes `answerWaitMs`, and the reply contains "next tool call". After the
    consult resolves, `take(folder)` returns the framed answer once, and a second `take` returns `""`.
  - `blockedOn is set and cleared`: on success, timeout and throw.
  - `resource need`: the fake catalogue's matches lead the reply and appear in the consult prompt.
    With no catalogue, the ask still works.
  - `ping-pong`: A→B open plus B→A is allowed, and a second A→B is refused (`maxOpenPerPair`).
  - `tell`: refused for a non-company caller. Live session → held + 1 `agent_tell` + 1 line. No
    session → `notes.send` called once with kind `fyi` from `main`. Secret, size and rate refusals.
    `followUp` is never called (spy).
  - `take frame and cap`: the frame starts with `[Neo · information, not a new task — continue your current brief]`.
    With 3 held rows over `deliverMaxChars`, the first fit, and the rest come on the next `take`, in order.
  - `sweep`: a held row older than `holdMaxMs` → `expired` + 1 fyi note. An `answering` row found at
    boot → `failed (reload)` + a held failure line for the asker.
- [ ] Step 3: Run both → FAIL.
- [ ] Step 4: Implement:
  - Use one `Promise.race` of the consult against a fake-clock-aware timer.
  - Keep the consult promise; on settle, write the answer row `held` if the wait already ended.
  - Count the concurrency in memory and re-derive it from `answering` rows at boot.
- [ ] Step 5: Both tests and `bunx tsc --noEmit` → PASS.
- [ ] Step 6: Commit `feat(agents): agent post — guarded asks, held tells, delivery and expiry (ADR-0050, P3.1)`.

## Phase 4 — consult runs and wiring

### Task 8: Consult runner (session-runner adapter) + consult profile
**Files:**
- Create: `src/engine/consult.ts`, `tests/consult.test.ts`
- Modify: `src/config.ts` (`WorkerPathName` += `"consult"`), `src/engine/worker-profile.ts` (the consult defaults of spec §4), `src/engine/session-runner.ts` (`RunDeps.forkSession?: boolean`, `RunDeps.saveSession?: false`; pass `forkSession` to `query`)

**Interfaces:**
- Consumes: `ConsultRunner` (T7); `Catalogue` (T6b); `memoryTools` read tool; the stall limit from dispatch.
- Produces: `createConsultRunner(deps: { start: typeof start; cfg: NeoConfig; catalogue?: Catalogue; ledger; trace }): ConsultRunner`; `consultPrompt(job: { asker: string; need: Need; question: string; matches: ToolMatch[]; answerMaxChars: number }): string`.

- [ ] Step 1: Failing tests, using a fake `start` that captures the RunDeps:
  - `disallowedTools` ⊇ Write, Edit, NotebookEdit, Bash, Task, Agent, KillShell, SlashCommand.
  - The `neo` server lists exactly `tools_for` and the memory read tool.
  - `onEscalation` always returns `deny`.
  - `forkSession: true` together with `resume: forkFrom`. A fresh job has neither.
  - The session id is never written by `ledger.saveSession` (spy), and `registry.add` is never called (spy). A consult never makes a project busy.
  - The order is recorded with the job's cause.
  - `consultPrompt` quotes the question as data, names the asker from the job (not the text), and
    contains "answer only", "never a secret value — point to tools_for / tool_api" and "if work is
    needed, say so: the asker files a project_notes request".
  - A stalled fake run → `{ok:false}`.
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement with `start()` and the per-path profile (model and effort from `config.workers.consult`). Collect the final `result` text as `answer`.
- [ ] Step 4: PASS plus `bunx tsc --noEmit`.
- [ ] Step 5: Commit `feat(agents): read-only consult runs fork the target's session (ADR-0050, P4.1)`.

### Task 9: `ask_agent` / `tell_agent` tools, the delivery hook, turn-start delivery
**Files:**
- Modify: `src/engine/dispatch.ts` (`DispatchDeps.agentPost?: AgentPost`; the tools in `neoMcpServers` after `project_notes`; the dispatch follow-up prepends `take`), `src/engine/session-runner.ts` (a PostToolUse hook next to the governor hook, enabled by `RunDeps.deliver?: () => string`), `src/engine/pipeline.ts` (the follow-up and resume paths prepend `take`; `deliver` for operator sessions), `src/engine/ingress.ts:93` (`agentPost: undefined`), `src/daemon.ts` (build the post, the resolver and the consult runner; `sweep()` at boot and on the tick)
- Test: `tests/agent-tools.test.ts`, `tests/agent-delivery.test.ts`

**Interfaces:**
- Consumes: `AgentPost` (T7), `createConsultRunner` (T8).
- Produces: tool `ask_agent({ to: z.string(), question: z.string(), need: z.enum(["info","resource","help"]).optional() })`; tool `tell_agent({ project: z.string(), message: z.string() })`; `RunDeps.deliver`.

- [ ] Step 1: Failing tests:
  - `ask_agent on operator workers only`: present for the company, project and dispatch servers.
    Absent for the ingress server, the consult server, and when `agentPost` is unset.
  - `tell_agent only on the company`: the server with `opts.dispatch` has it; a dispatched worker does not.
  - `Caller from the session`: the tool passes `projectName`, folder, session, order, `liveCause()`
    and `workClass` from the closure, and the args cannot set them.
  - `hook delivers once`: a fake run whose PostToolUse hook is called twice with one held row → the
    first output has the `additionalContext` frame, and the second has none.
  - `no hook on tainted / consult`: their RunDeps have no `deliver`.
  - `turn start prepends`: `handleMessage` into a live session with a held tell → the follow-up text
    starts with the frame, then the operator's text.
  - `dispatch stall clock holds during the wait`: using the existing stall test harness, `blockedOn
    agent` for longer than `stallMs` → no stall abort.
- [ ] Step 2: FAIL.
- [ ] Step 3: Implement. The tool descriptions copy the spec §2 rules: ask for facts, tools or
  how-to; never ask another agent to do work (that is `project_notes`); never ask for a key (that is
  `tools_for`/`tool_api`).
- [ ] Step 4: PASS plus `bunx tsc --noEmit` plus `bun test` (full).
- [ ] Step 5: Commit `feat(agents): ask_agent and tell_agent, delivered only at tool boundaries and turn starts (ADR-0050, P4.2)`. **Merge P3–P4 → dev.**

## Phase 5 — visibility, docs, review

### Task 10: Trace rendering + console lines (AR+EN)
**Files:** `src/engine/trace.ts` (`renderTrace` lists `agent_messages` rows of the thread), `src/frontends/web/app.ts` (thread view line kinds), `src/frontends/web/locales/{en,ar}/console.json` (`agents.asked`, `agents.answered`, `agents.told`, `agents.refused`); tests `tests/trace-agents.test.ts`, `tests/console-i18n.test.ts`.
- [ ] Step 1: Failing tests:
  - `/trace` of a thread with one ask and its answer shows `ask main (resource) → answered 42s` under the asker's message.
  - The four keys exist in EN and AR.
  - Numbers render inside an LTR isolate (the existing pattern).
- [ ] Steps 2–4: FAIL → implement → PASS.
- [ ] Step 5: Commit `feat(agents): asks, answers and tells in /trace and the console (ADR-0050, P5.1)`.

### Task 11: Preamble, docs, security and code review
**Files:** `src/engine/dispatch.ts` (preamble), `CLAUDE.md` (status + map), `docs/HISTORY.md`, `docs/CONFIG.md`, `README.md` (the tools list), ADR-0044 and ADR-0050 → accepted, `HANDOFF.md`.
- [ ] Step 1: Failing test in `tests/dispatch.test.ts`: the preamble contains `ask_agent` and
  `tools_for` and is shorter than 5000 chars. The clause to fit: "Missing a fact, tool or key? ask_agent (main or a project) and tools_for — never wait silently, never paste keys." Reword the existing text to make room.
- [ ] Steps 2–4: FAIL → implement → PASS.
- [ ] Step 5: Run `/security-review` on the branch (input handling, keys, the relay). Then
  superpowers:requesting-code-review. Fix the findings. Run full `bun test` and `bunx tsc --noEmit`.
- [ ] Step 6: Commit `docs(agents): preamble clause, docs, ADR-0044/0050 accepted (P5.2)`. Merge →
  dev. Remove the `node_modules` link, then `git worktree remove /home/neo-agent-messaging` (the
  branch stays).

## Rollout (operator steps; nothing here runs without the operator)

| Step | What | Gate |
|---|---|---|
| 1 | Merge `dev` → master, restart neo.service | operator. dev also migrates the ledger to v13 at start (backup `ledger.db.bak-v12`) |
| 2 | `ask_agent` / `tell_agent` / `tools_for` / the hint / the relay code | live after step 1 (`agents.enabled` defaults to `true`) |
| 3 | Install the tool skills: `bun tools/catalogue/install.ts` | operator go-ahead (writes `~/.claude/skills`); no restart |
| 4 | Read the `worker_env_report` names, set `agents.workerEnv.inherit`, then `engineSecrets: "strip"` | operator. Takes effect at the next restart |
| 5 | The relay calls out: `tools.relayEnabled: true` | operator |
| 6 | ScaleDown to `active` | operator: DPA + quota (ADR-0044 Task 13) |
| Off switch | `agents.enabled: false` in `config.json`, then a restart | operator |
