---
approval: required
---
# Agents ask and tell each other — design (ADR-0050, with ADR-0044)

**Order (operator, 2026-10-25):** workers must be able to ask the main agent or another project's
agent for information or help, and the main agent must be able to give information to a running
worker. Shared keys and tools go through the engine, never as raw values. **Example of the gap:**
eticket-v3 #591 needed the ScaleDown key and tool. The main agent knew about them, but the worker
could not ask. **Decision:** ADR-0050. **Resources:** ADR-0044 (tools catalogue: spec
`2026-10-22-tools-catalogue-design.md`). This plan builds it, approved together with ADR-0050.
**Terms:** `CONTEXT.md` § Agents asking each other, § Shared tools.

## 1. The seam

One deep module, `src/engine/agent-post.ts`, with a small interface:

```ts
createAgentPost(deps: {
  ledger: AgentPostLedger;        // agent_messages rows + countEvents (ledger adapter | fake)
  consult: ConsultRunner;         // runs one consult run (session-runner adapter | fake)
  targets: TargetResolver;        // "main" | project → {folder, name, lastSession?, occupancy?, sdk}
  catalogue?: Catalogue;          // ADR-0044 tool search, for need:"resource"
  notes?: ProjectNotes;           // fallback delivery (ADR-0043)
  trace: Pick<Trace, "outbound">; // compact lines
  reserve: () => boolean;         // heldByReserve for background work
  cfg: AgentsCfg; now: () => number;
}): AgentPost

interface AgentPost {
  ask(from: Caller, req: { to: string; question: string; need: Need }): Promise<string>; // the tool result text
  tell(from: Caller, req: { project: string; message: string }): string;
  /** Called at a delivery point: every held message for this session, framed, then marked
   *  delivered. Returns "" when nothing is held. */
  take(sessionId: string): string;
  /** On reload / tick: expire held rows older than holdMaxMs into fyi notes. */
  sweep(): void;
}
interface Caller { project: string; folder: string; sessionId: string; orderId?: string;
                   cause?: Cause; workClass: WorkClass; chain: string[] }
type ConsultRunner = (job: { folder: string; forkFrom?: string; prompt: string; cause?: Cause;
                             workClass: WorkClass }) => Promise<{ answer: string; ms: number; ok: boolean }>;
```

The pure guard `checkAsk(from, req, counts, cfg) → { ok } | { refused: rule }` and the pure frame
`frameHeld(rows) → string` live inside the module and are tested directly.

Thin users:
- In `neoMcpServers`: `ask_agent` (every operator worker), `tell_agent` (only the company, `opts.dispatch`).
- The **delivery hook**: a PostToolUse hook next to the governor hook (ADR-0006) returns
  `{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: post.take(sid) } }`
  when `take` is not empty. The **turn-start path** (`pipeline.handleMessage` follow-up and the
  dispatch follow-up) prepends `take(sid)` to the next message.
- `daemon.ts`: wiring, and `sweep()` on the existing tick.

## 2. `ask_agent`

Tool input (zod): `to: string` (`"main"` or a project name), `question: string`,
`need: "info" | "resource" | "help"` (default `info`). The tool description says: ask for facts,
shared tools or how-to; never ask another agent to do work (use `project_notes` request); never ask
for a key (use `tools_for` / `tool_api`).

Flow:
1. **Guard** (`checkAsk`, in this order; the first refusal returns `isError` text naming the rule;
   nothing starts): `enabled` → target resolves (folder under the work root, or `main`) and is not
   the asker → `question` non-blank, ≤ `questionMaxChars`, no `findSecret` match → depth <
   `maxDepth` and target not in `chain` → open asks for (asker, target) < `maxOpenPerPair` → asks by
   this order in the last hour < `maxPerOrderPerHour` (background: `backgroundMaxPerOrder` per order)
   → asks by this project in 24 h < `maxPerProjectPerDay` → running consults <
   `maxConcurrentConsults` → background work and `reserve()` is held → refuse.
2. **Record** an `agent_messages` row (kind `ask`, status `answering`) with the cause, the thread,
   the depth and the chain, plus the `agent_ask` event and one notice line:
   `↔ eticket-v3 asked main (resource): <question cut to 120 chars> · <ref>`.
3. **Resource matches:** for `need: "resource"` with a catalogue, `catalogue.find(question, {project})`
   (top 3). The matches go into the consult prompt and at the top of the tool result.
4. **Consult** (`ConsultRunner`): the target's folder. `forkFrom` = the target's last **saved**
   session id (`ledger.lastSessionFor`), but only when:
   - the target's registry session is **not in a turn** (`control.active()` is false, or there is no
     live control), so the transcript never ends on an open tool call;
   - it uses the same SDK;
   - its last occupancy is ≤ `forkMaxOccupancyPct`.

   Otherwise the consult starts fresh. A consult run is recorded as a ledger **order** (path
   `consult`, with the asker's cause), so budget, `/trace` and the stall limit see it. It is **never
   registered** in the session registry, so it never makes a project busy, never takes a held
   message, and never shows as a worker in the project view.
   The prompt is a fixed engine frame: who asks (project, not text-controlled), the need, the
   question as quoted data, the resource matches, and the rules (answer only; read-only; no secret
   values, point to tool cards / `tool_api`; if work is needed, say so and suggest the asker files a
   `project_notes` request; ≤ `answerMaxChars`). The consult worker profile (path `consult`, §4).
5. **Wait:** `registry.noteBlocked(sid, {kind:"agent", label:"asked main"})`, then race the consult
   against `answerWaitMs`. Clear the block in `finally`.
6. **Answer in time:** check `findSecret` (on a match, withhold: the fixed line "the answer held a
   secret-looking value and was withheld — use tools_for / tool_api"). Cut to `answerMaxChars`.
   Mark the row `answered`, write an `agent_answer` event and the notice line `↩ main answered
   eticket-v3 in 42s · <ref>`, and return the answer.
7. **Answer late:** return "No answer yet (id a12). It will be given to you at your next tool call or
   turn. Continue other work; if you are blocked, check-point and raise ask_operator." When the
   consult ends, the answer row is `held` with `to_folder` = the asker's folder and `to_session` =
   the asker's session.

**Who takes a held row.** A row has `to_folder` and an optional `to_session`:
- While `to_session` is a live registry session, only that session takes the row.
- Once that session has ended (it is no longer running in the registry), any operator session of
  the folder takes it, at its first delivery point.
- Tells have no `to_session`.
- `take(sessionId)` looks up the session's folder and applies this rule. It marks rows `delivered`
  in the same transaction, so a row is delivered exactly once even when two sessions share a folder.
8. **Consult failed** (stall, error, empty answer): the row becomes `failed`. The asker gets (in
   time or held) "main could not answer (<reason>). If you are blocked, raise ask_operator."

## 3. `tell_agent` (company only)

Input: `project: string`, `message: string`. Guard: `enabled`; the caller is the company; the target
resolves and is not a desk; non-blank; ≤ `tellMaxChars`; no `findSecret`; tells to this project in the
last hour < `maxTellsPerProjectPerHour`. Then:
- The project has a registry session that is running or idle with a saved session → a row `held`
  for that project's folder (not a session id: a fresh session of the same folder also takes it),
  an `agent_tell` event, and the notice line `→ main told eticket-v3: <cut> · <ref>`. The tool returns
  "held; it will reach the worker after its next tool call or at its next turn".
- No session → an `fyi` project note from `main` (`project_notes` send path, ADR-0043). The tool
  returns "no session — left as a note for its next start".

## 4. Consult worker profile

A new `WorkerPathName` `"consult"` in `config.workers` (the context-efficiency per-path profiles):
- `disallowedTools`: Write, Edit, NotebookEdit, Bash, Task, Agent, KillShell, SlashCommand.
- MCP: `neo` with only `tools_for` and the memory read tool (`memory_search`); codebase-memory.
  No ask_agent, tell_agent, dispatch, todo, ask_operator, send_file, tool_api, project_notes.
- Every escalation is `deny` (the project-loop rule). The project fence applies.
- `maxTurns` = `agents.consultMaxTurns`. The dispatch stall limit applies. Never saved as the
  target's session (`saveSession: false`). `forkSession: true` when `forkFrom` is set.
- The model and effort come from `config.workers.consult` (no hardcoding). The default is the
  dispatch model.

## 5. Delivery points

- **Tool boundary:** the PostToolUse hook asks `take(sessionId)`. If the text is not empty, it
  returns it as `additionalContext`. It runs for Claude operator workers (pipeline + dispatch), never
  for tainted runs or consult runs. The text is framed:
  `[Neo · information, not a new task — continue your current brief]\n• main (tell, 14:02): …\n• answer to your ask a12 from main: …`.
  It is capped at `deliverMaxChars`; the rest waits for the next point.
- **Turn start:** before the engine sends a follow-up into a session (an operator message, a decision
  answer, a todo follow-up), it prepends `take(sid)`.
- **Never** starts a turn by itself. `take` marks rows `delivered` with the time, in one transaction.
- **Expiry:** `sweep()` turns `held` rows older than `holdMaxMs` into an `fyi` note to the target
  project (status `expired`).
- **Codex sessions:** no hooks, so only turn start, then expiry.

## 6. Resources and the worker environment (ADR-0044 + ADR-0050 §4)

- Build ADR-0044 Phase 1 and 2 as its plan says (cards, skills, `tool_api` relay, `tools_for`, the
  tools hint). The consult profile gets `tools_for`.
- **Env scrub** (`src/engine/worker-env.ts`, pure: `scrubWorkerEnv(env, { engineKeys, relayKeys,
  inherit, mode }) → { env, stripped: string[] }`):
  - `relayKeys` = every catalogue card's `relay.envKey`. These are always removed.
  - `engineKeys` = the key names that `loadDotEnv` set from Neo's `.env`. The loader returns them,
    and the values are never read again.
  - `mode: "report"` (default): records `worker_env_report {names}` once per daemon start and
    removes only `relayKeys`. `mode: "strip"`: removes every key in `engineKeys` that is not in
    `inherit`.
  - `inherit` defaults to the auth keys the SDKs need (in config, not code: for example
    `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY`).
  - Called in `mergedSdkEnv` for every provider.

## 7. Trace and visibility

- `agent_messages.cause_msg_id/thread_id` = the asker's cause. The consult run's order carries the
  same cause, so `/trace` lists: the ask → the consult order → the answer.
- `renderTrace` shows the `agent_*` rows as one line each (`ask main (resource) → answered 42s`).
- Notice lines go through `trace.outbound` (kind `notice`, priority `progress`), so they are in the
  console feed and the Telegram DM, cut by the flood gate rules. They are never a Decisions-group line.
- Console: the thread view renders the three line kinds with i18n keys in
  `locales/{en,ar}/console.json` (`agents.asked`, `agents.answered`, `agents.told`,
  `agents.refused`). Numbers (seconds, refs) stay LTR as isolates.

## 8. Config (`config.agents`, `docs/CONFIG.md`; a bad value falls back to the default, as `readNotesCfg` does)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | the switch for ask/tell (the tools are absent when off) |
| `answerWaitMs` | `240000` | how long `ask_agent` holds the call |
| `consultMaxTurns` | `12` | the turn cap of one consult run |
| `forkMaxOccupancyPct` | `60` | fork only below this occupancy; otherwise fresh |
| `maxDepth` | `1` | the longest ask chain |
| `maxOpenPerPair` | `1` | open asks from one asker to one target |
| `maxPerOrderPerHour` / `backgroundMaxPerOrder` | `6` / `2` | asks per order |
| `maxPerProjectPerDay` | `40` | asks per asking project |
| `maxConcurrentConsults` | `2` | consult runs at once |
| `maxTellsPerProjectPerHour` | `6` | tells to one project |
| `questionMaxChars` / `answerMaxChars` / `tellMaxChars` / `deliverMaxChars` | `1500` / `4000` / `1500` / `6000` | size caps |
| `holdMaxMs` | `86400000` | a held message expires into a note after this |
| `workerEnv.engineSecrets` | `"report"` | `"report"` or `"strip"` (§6) |
| `workerEnv.inherit` | SDK auth key names | engine keys workers keep |

## 9. Acceptance criteria

1. `checkAsk` refuses, with no consult started and a reply naming the rule, for each guard in §2.1:
   disabled, an unknown target, the asker itself, a blank / long / secret question, depth, a target
   in the chain, a pair already open, the per-order / per-project / background caps (rows at 25 h do
   not count), the concurrency cap, and the background reserve.
2. A good ask records one row and one `agent_ask` event (no text in the event), shows one notice line
   with the asker's cause, starts exactly one consult in the target folder, forks from the last
   session when it exists below `forkMaxOccupancyPct`, and starts fresh otherwise (including for
   another SDK's session).
3. An answer in time → it is the tool result, the row is `answered`, and there is one `agent_answer`
   event. A secret-looking answer → the fixed withheld line, and the value appears in no row, event,
   line or reply (a sentinel test).
4. A late answer → the tool returns the "later" text by `answerWaitMs` (fake clock). The answer is
   then delivered once: at the next tool boundary (`take`) or turn start, never twice, and never as a
   new turn.
5. `blockedOn {kind:"agent"}` is set during the wait and cleared afterwards, on success, timeout and
   throw alike. The dispatch stall clock does not run during the wait (a test against the existing
   stall loop).
6. The consult run's options: the disallowed tools of §4, a `neo` server with only `tools_for` and the
   memory read tool, escalation always `deny`, `forkSession: true` when forking, and the session id
   never stored as the target's.
7. `need: "resource"`: the catalogue matches lead the tool result and are in the consult prompt.
   Without a catalogue, nothing breaks.
8. `tell_agent` exists only on the company's `neo` server. A tell to a live session is held and
   delivered at the next tool boundary with the fixed frame. A tell to a project with no session
   becomes one `fyi` note from `main`. A tell never calls `followUp` by itself. Secret, size and rate
   refusals work.
9. Tainted runs, ingress, consult runs, loops and Codex never have `ask_agent` or `tell_agent`. The
   delivery hook is not installed on tainted or consult runs.
10. Two agents cannot ping-pong: A→B open plus B→A is allowed once (separate chains), and a second
    A→B while the first is open is refused. A consult run cannot ask (no tool).
11. `sweep()` expires a held row after `holdMaxMs` into exactly one `fyi` note, and a reload keeps
    held rows (they live in the ledger).
12. `scrubWorkerEnv`: relay keys are always removed. In `report` mode, engine keys stay and their
    names (never values) are recorded once. In `strip` mode, engine keys go except `inherit`. A
    sentinel value never appears in an event or a log.
13. Migration v13 creates `agent_messages` (with a `to_session` column) and the indexes on `(to_folder, status)` and
    `(from_order, created_at)`. The v12 → v13 migration test passes on a copy.
14. Console i18n: the four keys exist in EN and AR (the existing console-i18n test pattern).
15. The preamble gains one clause naming `ask_agent` and `tools_for` and stays under its 5000-char cap
    (reword; do not append).

## 10. Edge cases

- The target is the company and the company is mid-turn (with the operator, or inside the `dispatch`
  call that started the asker): no fork. The consult starts fresh in `/home/neo/agent`, where it
  still has the main agent's `CLAUDE.md` and memory. The company session is untouched. (Phase 0 also
  checks whether a mid-turn fork is safe. If it is, a later change may relax this rule. This plan
  does not.)
- The target's last session is from another SDK, or its transcript was pruned: fresh start (the
  `resumeMissing` path already exists).
- The asker's run ends before a late answer: the row stays `held` for the asker's folder. The next
  session of that folder gets it at its first delivery point, or `sweep()` turns it into a note.
- The daemon reloads during a consult run: the run is aborted by the reload like any run. The row
  becomes `failed (reload)` on start-up, and the asker gets the failure at its next delivery point.
- An Arabic question: passed through as is; the consult worker answers in kind.
- A question that is really an order ("please fix X in your repo"): the consult run cannot write.
  Its frame tells it to answer "this needs work — file a project_notes request".
- Two asks from one worker to two targets at once: allowed (the pair cap is per target).

## 11. Not in scope

- Ask/tell tools for loops and Codex (the ADR-0044 gap; one follow-up for both).
- Project-to-project tells (projects already have `project_notes`).
- Fixing `dispatchToProject`'s follow-up into a running session when there is no todo queue (noted
  in ADR-0050).
- Promoting ScaleDown to `active` (needs the operator: DPA and quota, ADR-0044 Task 13).
- ADR-0044 Phases 3–5 (usage boost, recipes, skillify, enrichment loop): they follow their own plan
  after this one.
