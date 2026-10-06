# Making Neo far more productive: what new agents do that Neo doesn't (2026-10-04)

This builds on [neo-vs-new-agents.md](neo-vs-new-agents.md); it does not repeat it. That write-up compared Neo with Dots, Grok Bot and Muse and ranked seven fixes. This one goes wider (about 40 commercial and open-source agents) and deeper: the specific mechanisms behind each one, and how each would fit Neo's code. It covers agent capabilities only. Multi-channel UI and the one-man-company vision are handled in sibling threads.

Neo's state is read from `master` @ 60b87b9. Agent facts come from two research passes on 2026-10-04, with sources at the end. **[unverified]** marks claims backed only by a single vendor post or secondary blog.

---

## 1. The short version

Agents that do real work in 2026 have converged on five habits. Neo has the foundations for all five but uses only part of each.

| Habit | Who does it best | Neo today | Gap |
|---|---|---|---|
| **1. Wake the model only when there is work** | Hermes `wakeAgent` script gates, Symphony reconcile ticks, OpenClaw heartbeat with `isolatedSession` | Loops always start a worker when the trigger fires | Most polling loops burn a worker run to find nothing |
| **2. Get triggered by events, not just clocks** | Claude Routines (API/GitHub), Cursor Automations (Slack/Linear/PagerDuty/webhook), Devin (Sentry/CI), Mail Manus, Gemini Spark | `manual`, `interval` and `cron` only (`src/engine/trigger.ts:5-8`) | Neo can't react to a failed CI run, a GitHub issue, or a forwarded email |
| **3. Prove "done" with a separate check and show evidence** | Anthropic Outcomes (isolated grader), Devin 2.2 (screen recordings), Antigravity Artifacts, Composio "reactions" | Goal checks exist, but only on loops (`goal.ts`), and nothing feeds CI or review results back | Ad-hoc orders and dispatches end when the worker says so |
| **4. Run many tasks in parallel, safely** | Manus Wide Research (fresh context per item), Factory Missions and vibe-kanban (worktree per task), Symphony (slots, stall-kill, backoff) | One worker per folder: `isFolderBusy` blocks a second loop (`scheduler.ts`); team mode is two fixed roles | Neo can't work three tasks in one repo at once |
| **5. Learn from corrections, under review** | Cursor Bugbot Learned Rules, Hermes Curator, hermes-self-evolution (gated PRs), Devin Session Insights, Anthropic Dreaming | Capped memory, FTS recall, dream loop (off by default) | Corrections aren't captured as data; skills never improve |

Underneath all five is a sixth: **approval that scales**. The more autonomy an agent gets, the more its approval system decides whether the operator drowns in prompts or trusts the output. Muse's Sentinel, Dots' allow/ask/block rules and Grok's learned escalation are all attempts at this. Muse's address-leak incident (section 3F) shows what happens when the check looks at tools but not content.

**My recommendation:** build in three waves (section 4). Wave 1 is cheap engine work that roughly doubles what Neo does unattended: script gates, silent delivery, event triggers, and a "done" check on every order. Wave 2 adds parallelism and the CI/review feedback loop. Wave 3 is the learning loop.

---

## 2. What Neo already does better than most of them

So these don't get rebuilt:

- **Governance lives in code.** The default-escalate governor, the path fence, and zero-tool tainted briefs already follow the pattern the field reached after its incidents. Simon Willison's "lethal trifecta" (private data + untrusted content + the ability to send data out) is solved in Neo by removing a leg in code. Muse, Dots and Claude's auto mode all rely on a classifier instead, and the classifier misses things (section 3F).
- **Verifiable goals on loops.** Neo's command goal (exit 0) is the "executable feedback" that the 2026 self-evolving-agents survey (65 papers) names as the one thing that makes autonomy work.
- **No marketplace.** ClawHavoc put 1,184 malicious skills on ClawHub, and some of them poisoned agent memory files. Neo's first-party-only rule and its memory-write scanner are exactly the right call.
- **Your own server and folders.** Every rival now sells "its own computer" (Dots, Grok Bot, Gemini Spark, Muse's VM). Neo is the same shape, except the computer is yours.

---

## 3. Mechanisms worth taking, with a Neo design for each

Each item lists its source, how it works, and how it lands in Neo while keeping "no AI in the engine". Effort is **S** (a few days), **M** (a week or two) or **L** (more).

### A. Zero-token autonomy (habit 1)

**A1. Script gate before waking the model (S).**
- **Source:** Hermes cron. A pre-run script's last line `{"wakeAgent": false}` skips the LLM call entirely. Symphony does the same with a reconcile step before each dispatch.
- **Neo design:** add an optional `gate: { command: string[] }` to a loop definition. On each due tick, `scheduler.ts` runs the gate deterministically.
  - A non-zero exit, or empty stdout, means skip. Record `lastRun` plus a `loop_gated` event.
  - Exit 0 with output means start the worker, with the gate's stdout put into the brief ("here's what changed").
- **Why it matters:** a "check for new GitHub issues every 5 minutes" loop costs zero tokens until an issue exists. This one feature makes frequent polling affordable on a subscription.

**A2. Script-only loops (S).**
- **Source:** Hermes `--no-agent` jobs. Non-empty stdout is delivered word for word, empty stdout is a silent tick, and a non-zero exit sends an alert.
- **Neo design:** a new loop action kind, `{ kind: "script", command }`, next to the worker action. It covers uptime pings, disk and backup checks, and "did the nightly deploy succeed" with no worker and no budget.

**A3. Silence by default, and grouped failure alerts (S).**
- **Source:** OpenClaw `HEARTBEAT_OK`, Hermes `[SILENT]` and failure signatures.
- **Neo today:** a scheduled fire that emits nothing is already silent (HISTORY.md, loop runtime).
- **Neo design:**
  - Add the explicit sentinel, so a worker can say "nothing to report" without being forced to emit nothing.
  - Group loop failures by a normalised signature in the ledger. Alert once, then re-alert on a cooldown.
  - The inverse alert: warn when a loop has produced no output or no goal-met for N runs in a row. ChatGPT's scheduled tasks reportedly died silently when agent mode was retired **[unverified]**, and that is the failure this catches.
- **Overlap:** the heartbeat thread already in flight owns the heartbeat-specific part. This is the general loop-delivery version.

### B. Event triggers (habit 2)

**B1. An authenticated `/fire` endpoint with a text payload (S).**
- **Source:** Claude Routines' API trigger (POST with a bearer token and optional `text`); Cursor Automations' webhooks.
- **Neo design:**
  - Add `POST /fire/:loop` to `frontends/web.ts`, authorised with a per-loop HMAC token stored in `.env`.
  - The `text` field is put into the brief with a `fireReason`, and the SDK's own `fireReason` field is used where it exists. Record it in the ledger so digests can say why each run happened.
  - **Firewall rule:** `/fire` payloads are operator-source only. A loop meant for outside callers (forms, customer webhooks) must be marked tainted: zero tools, or Gemini later.

**B2. GitHub, CI and Sentry triggers with filters (M).**
- **Source:** Claude Routines (GitHub events filtered by author, branch, label and draft status); Cursor (PagerDuty, Linear); Cognition runs Devin on Sentry, CI and deploy failures through its API and keeps fixing CI until it passes.
- **Neo design:** a `{ kind: "github", events, filter }` trigger fed by a webhook receiver. Polling through a script gate (A1) is the zero-infrastructure first step.
- **Safety:** issue and PR bodies written by third parties are untrusted content.
  - Default these triggers to a read-only investigate profile.
  - Write tools only for events whose author is on an allowlist (you and your bots).

**B3. Email-to-task for the operator only (M).**
- **Source:** Mail Manus. Each user gets a personal address; only allow-listed senders trigger tasks; purpose addresses (travel@, invoices@) carry stored instructions; replying "Cancel" stops a task. Gemini Spark has its own Gmail address.
- **Neo design:** `neo+<project>@` addresses whose sender must pass SPF/DKIM **and** be on an operator allowlist. A matching message becomes an `Order(source:"neo")` routed to the project's playbook. Anything else goes down the existing customer inbox path (zero tools).
- **Why it matters:** forwarding an email is the lowest-typing way to hand Neo a task.

**B4. `at` and `on-exit` triggers (S).** These are already specified as Phase 5 item 14. Moving them into Wave 1 is cheap, and `at` is what "remind me / check this tomorrow" needs.

### C. Verified "done" and the feedback loop (habit 3)

**C1. A goal check on every order, not just loops (M).**
- **Source:** goose recipes (`retry.checks`: shell commands that must pass, with `max_retries`); Archon (loop until `ALL_TASKS_COMPLETE`); Symphony (continue on a normal exit).
- **Neo design:**
  - Let a dispatch or `/open` order carry `checks: string[]`, or default to the project's own `bun test` / `tsc` when the project declares them in a `neo` block in its CLAUDE.md or `package.json`.
  - After the worker's final turn, the engine runs the checks. If any fail, it resumes the same session with the failure output, up to N times, then reports.
- **Reuse:** `loop-runner.ts` already has exactly this iterate → check → resume shape, so this mostly means routing ad-hoc orders through it.
- **Why it matters:** this is the biggest quality jump available. Today a dispatch ends when the worker *says* it is done.

**C2. An isolated rubric grader (S–M).**
- **Source:** Anthropic Outcomes, which runs a grader in isolation from the agent's reasoning and returns specific deficiencies (+8–10 points of task success on file outputs); Dots' auto-review; Devin's "Review Autofix" before a PR opens.
- **Neo today:** a `judge` goal exists but returns only DONE or not.
- **Neo design:** upgrade the judge to return a structured deficiency list, fed into the next resume.
  - The grader sees only the deliverable (diff, files) plus the rubric, never the worker's transcript, so it can't be talked into a pass.
  - It runs on the `judge` worker profile, which already exists.

**C3. Evidence card per run (S).**
- **Source:** Antigravity Artifacts (plan, task list, screenshots, recordings, which the user comments on like a doc); Devin's screen recordings.
- **Neo design:** every order ends with a structured result recorded in the ledger: what changed (diff stat), checks run plus exit codes, the cost, and a link to the web console. Telegram shows it as a compact card.
- **Rule:** "Green" means the checks or grader passed, never just "the worker exited cleanly". Claude Routines' own docs warn that their green means only "no infrastructure error".
- **Overlap:** the card's visual form belongs to the graphical-channel thread; the data contract belongs here.

**C4. Reactions: route CI failures and review comments back to the session that made the PR (M).**
- **Source:** the ComposioHQ agent-orchestrator. A session goes spawned → active → suspended → resumed with feedback → completed or escalated, with `escalate_after: 2`. Devin keeps fixing CI until it passes.
- **Neo design:**
  - When a worker opens a PR, record `(repo, pr, sdkSessionId)` in the ledger.
  - A gated loop (A1) polls check runs and review comments, or a webhook (B2) receives them, and resumes that exact session with the failure log.
  - After N failed rounds, escalate to Neo.
- **Why it matters:** with C1 this closes the "it opened a PR, then CI went red and nobody noticed" gap. It is the single most productive loop for coding work.

### D. Parallel throughput (habit 4)

**D1. A git worktree per concurrent task (M).**
- **Source:** vibe-kanban, Claude Squad, Archon and Factory Missions all do this. Emdash also gives each task its own `$PORT` so dev servers don't collide.
- **Neo design:** when a second order targets a busy git project, the engine runs `git worktree add .neo/wt/<order-id> -b neo/<order-id>` and sets `cwd` there.
  - The governor's path fence follows `cwd`, so writes are fenced to the worktree automatically.
  - Inject `PORT` from a free-port allocator.
  - On completion, the worktree is cleaned up or left for review.
  - `isFolderBusy` becomes "the main checkout is busy", and slots become a ratio of observed rate-limit headroom (the no-magic-numbers law).
- **Why it matters:** this unblocks everything else in this section.

**D2. Wide dispatch: fan-out with fresh contexts (M).**
- **Source:** Manus Wide Research. Each sub-agent gets a fresh, empty context, sub-agents never talk to each other, and one controller synthesises. Manus's measured reason: quality drops around item 8–9 when items are processed one after another.
- **Neo design:** a `dispatch_many` tool for the company project takes N self-contained briefs, each with its own worker or worktree.
  - The engine collects each worker's structured result (from C3).
  - One synthesis worker writes the summary.
  - The engine does the fan-out and fan-in deterministically; the company only writes the briefs.
- **Uses:** "review these 12 repos for X", "research these 20 competitors", "update deps in all projects".

**D3. Board-driven dispatch with reconciliation (M–L).**
- **Source:** OpenAI Symphony's spec. On each tick it reconciles (kills runs whose issue went terminal), fetches eligible issues, sorts them by priority and age, and dispatches into free slots under per-state caps. It kills stalled runs after `stall_timeout` and retries with `min(10s·2^(n−1), max)`. A repo-owned `WORKFLOW.md` holds the config and prompt template and hot-reloads.
- **Neo design:** this is the engine half of Phase 4's board. The scheduler gets a "board source" (GitHub Issues first, a ledger table later) and dispatches labelled tasks into worktrees (D1), with checks (C1) and reactions (C4).
- **Overlap:** the one-man-company thread owns *what* the board is; this is *how* the engine drains it.

**D4. Leases and run linkage (S).**
- **Source:** Diagrid's critique of Microsoft Agent Framework: "Checkpointing is a storage operation, not a reliability guarantee". There are no leases, so two processes can resume the same checkpoint. goose's scheduler bugs: headless runs died at the first approval prompt, recipe model settings were silently ignored on the scheduled path, and sessions lost their `schedule_id`.
- **Neo design:**
  - Each loop or dispatch run gets a ledger lease (with heartbeat and expiry), so a reload or crash can't double-run it.
  - Stamp every SDK session with `loop_id` / `run_id`.
  - Fail loudly when a config value is accepted but not applied. Neo's `worker_compat_warning` is the right pattern; extend it to every profile field.

### E. Learning from corrections (habit 5)

The rule from every source: **the agent proposes, a gate decides, and every change can be undone.** The Darwin Gödel Machine faked its tool-use logs and deleted its own hallucination markers to score higher. It was caught only because its changes were traceable.

**E1. Capture corrections as data (S).**
- **Source:** Cursor Bugbot Learned Rules. Reactions, replies and human review comments create candidate rules; rules with positive signal are promoted, and rules that stop helping are disabled. Grok Teach-a-Task: "corrections inform the next run". Dots carries an edit across related deliverables.
- **Neo design:** the engine already sees the operator's messages. Record a `correction` ledger event when:
  - the operator denies an escalation;
  - the operator interrupts a worker with `/kill`;
  - a follow-up arrives within N minutes of a result in the same project (a deterministic heuristic; no AI decides what counts).
- The event stores pointers only, never message bodies (event-log policy).

**E2. Promotion and demotion in the dream loop (M).**
- **Source:** Bugbot (promote and demote); Mem0 (ADD/UPDATE/DELETE/NOOP); Anthropic Dreaming (writes a *new* store and leaves the original for review).
- **Neo design:** the nightly dream worker (which already exists) gets a new input: correction events plus the surrounding transcript excerpts.
  - It proposes rules as `MEMORY.md` replacements, written to a candidate file.
  - Neo approves on Telegram (one tap) or auto-applies under the existing mutation caps.
- **Gate:** run only after 24 h **and** N sessions since the last run, with a lock file. This is the reported Claude Code "Auto Dream" design **[unverified]**, and it is cheap to copy.

**E3. Skill proposals, staged and gated (M).**
- **Source:** Hermes writes a skill after a task with 5+ tool calls, after recovering from an error, or after a user correction **[unverified]**. hermes-self-evolution (DSPy + GEPA) mutates `SKILL.md` from failure traces. Each candidate must pass the test suite, size caps (≤ 15 KB skill, ≤ 500-character description), prompt-cache compatibility and semantic fidelity, then a **mandatory human PR review**. Devin Session Insights turns finished sessions into a better prompt for next time.
- **Neo design:**
  - At wrap-up of a session that had corrections or many tool calls, the worker may write `.neo/skill-proposals/<name>/SKILL.md`. That is inside the path fence; live skill directories are not.
  - The engine size-checks the proposal and sends a diff to Telegram: Approve copies it into `.claude/skills/` and commits; Reject records why.
  - This puts the CLAUDE.md rule "skillify anything done more than once" into the product.

**E4. A curator for agent-written skills (S).**
- **Source:** Hermes Curator. It runs weekly after 2 h idle, tracks views, uses and patches, moves skills active → stale (30 days) → archived (90 days), writes `REPORT.md`, and touches only skills the agent wrote.
- **Neo design:** count skill loads from SDK events in the ledger. A weekly loop archives unused Neo-authored skills and posts the report.
- **Why it matters:** it keeps skill context cost down. The context-efficiency spec measured superpowers alone at about 22k tokens.

**E5. Memory that invalidates instead of deleting (S).**
- **Source:** Graphiti/Zep bi-temporal facts. A contradicted fact's validity window is closed, not erased, so you can ask what was true "as of" a date.
- **Neo design:** add `valid_to` and `superseded_by` to recall rows, and have the dream loop close facts instead of removing them. This fits the existing `CONFLICT:` marker design.

**E6. Repeated work turns into scripts (M, later).**
- **Source:** Stagehand. The first run explores with the LLM and caches the actions; later runs replay with zero LLM calls and fall back to the LLM when replay breaks.
- **Neo design:** when the ledger shows a loop doing the same tool sequence run after run, the worker proposes a script-only loop (A2) to replace it, with the worker loop kept as the fallback. This is where token cost really falls over time.

### F. Approval that scales with autonomy

**F1. One policy table with allow, ask and block, using globs (M).**
- **Source:** Dots Custom Rules (allow / require approval / block); opencode's per-agent bash globs (`"git status *": "allow"`); Codex's granular approval policy.
- **Overlap:** this overlaps the connector-scopes thread, which owns the MCP read/send/deny part. The extension here covers **Bash command globs and file-path globs**, so `bun test`, `git status` and `git diff` never prompt while `git push` and `rm -rf` always do.

**F2. Scoped grants from Telegram buttons (S).**
- **Source:** Muse. Approvals are "strict capabilities, not conversational suggestions"; grants are one-time, task, time-bounded or perpetual; later calls must match the grant exactly.
- **Neo design:** an Allow/Deny prompt gets four buttons: Once / This task / 1 h / Always.
  - The grant is stored in the ledger as `(project, tool, pattern, scope, expiry)` and matched by `canUseTool`.
  - Worker text can never mint a grant; only a button press can.
  - "Always" writes a rule into the F1 table, so it shows up in `/audit`.

**F3. Learned escalation, offered rather than applied (S).**
- **Source:** Grok Bot. Bots "gradually learn when they should interrupt for approval versus continue."
- **Neo design (deterministic version):** count approve/deny per `(project, tool pattern)`. After N approvals with zero denials, Neo *offers* a one-tap "always allow". It never promotes on its own.
- **Why it matters:** in a few weeks this removes most of the prompt noise.

**F4. Proactive work is read-only by default (S).**
- **Source:** Dots runs proactive research with read-only connected apps; only directed and scheduled tasks get write gates.
- **Neo design:** loops and heartbeats that the operator didn't explicitly commission run with the `READONLY_DENY` profile (from `goal.ts`) unless the loop definition says otherwise.

**F5. Content checks on anything going out (S).**
- **Source:** Muse's 2026-09-26 incident. It gave a Marketplace buyer the seller's home address and replied "Yep I'm here!" while the user was away. Its 25k-character safety document never mentions addresses. Network-layer approval missed content-layer harm.
- **Neo design:** before any outbound send (inbox reply, Telegram to a third party, an email or HTTP MCP tool), run deterministic detectors for postal addresses, phone numbers, IBAN/card numbers, any value from `.env`, and the operator's own personal details from config. Any hit forces escalation whatever the tool rule says. Pure regex, no AI.

**F6. Turn the operator's "don't" into a rule (S).**
- **Source:** Claude Code's own docs. Boundaries stated in conversation ("don't push") are re-read from the transcript and can be lost to compaction, so a hard guarantee needs a deny rule.
- **Neo design:** a `/never <pattern>` command writes a block rule into the F1 table for the project, enforced by the governor regardless of context.

**F7. Use what the SDK added this year (S).** These are reported in the TypeScript SDK changelog. Verify each against the installed version, since `package.json` pins `"latest"`:
- `permissionPrompts: 'none'` and `result.permission_denials` for loops: show denials in the digest instead of losing them.
- `canUseTool` now receives `mcpServer.source`, so foreign MCP tools can be told apart without name parsing.
- `startup()` / `prewarm()`: about 20x faster cold start, so Telegram feels instant.
- `taskBudget`, and `agentProgressSummaries` for subagent progress lines.
- `forkSession`, `tagSession` and `listSessions`: tag sessions with `order_id` / `loop_id` (D4).
- Mirror Claude Code's rule that engine-injected messages say explicitly that **no human input has occurred**, so a worker never treats relayed text as Neo's approval.

### G. Workflows as files

**G1. A repo-owned workflow file (M).**
- **Source:** Symphony `WORKFLOW.md` (YAML front matter plus a prompt template, hot-reloaded); Archon YAML (AI nodes mixed with deterministic bash, test and git nodes, loop-until, approval gates); goose recipes (typed parameters, sub-recipes, `retry.checks`, per-recipe model).
- **Neo design:** an optional `NEO.md` front matter or `.neo/workflows/*.yaml` per project, declaring:
  - checks (feeds C1);
  - default worker profile;
  - port;
  - board labels (D3);
  - named playbooks, each with parameters, steps and checks.
- **How it runs:** the engine runs bash, test and git steps itself and sends only AI steps to a worker. That is "AI decides, engine acts" made literal.
- **Why it matters:** each project tells Neo how to verify itself, which C1 and D3 both need.

**G2. Playbooks invoked in a few words (S).**
- **Source:** Devin Playbooks ("a custom system prompt for a repeated task"); Decagon AOPs; Mail Manus purpose addresses.
- **Neo design:** `/run <playbook> [args]` or a Telegram button launches a stored playbook. When the ledger shows the same order shape three or more times, Neo proposes saving it as a playbook. This is the low-typing path from the capability side; the button UI belongs to the graphical-channel thread.

### H. Running it all cheaply and visibly

- **H1. Pause at the cap, never overrun (S).** Lindy moved to pausing at the credit cap after overage complaints. Neo's budget throttle already holds background work at the interactive reserve. Add per-loop daily run caps and a "paused at cap" notice, and show each run's cost on its evidence card.
- **H2. Regression tests for prompts and loops (M).**
  - **Source:** Decagon Simulations (mock users and real historical transcripts) and Sierra (simulations before release).
  - **Neo design:** a loop or playbook can ship golden fixtures (an input plus a rubric). A nightly eval loop replays them whenever a skill, prompt or model changes and posts regressions.
  - This is TDD for prompts, matching the repo's TDD rule. It is also the gate E3 needs before an auto-proposed skill goes live.
- **H3. Repo map in the worker brief (S).** Aider builds a tree-sitter reference graph, ranks files with personalised PageRank, and trims to a token budget. Neo already guarantees a codebase-memory index before dispatch; injecting a ranked, capped map into the brief would cut exploratory tool calls. Check first whether codebase-memory already exposes one.

---

## 4. Recommended order

The ranking is by unattended work gained per unit of effort. It assumes the in-flight threads land first (Telegram fixes, heartbeat, connector scopes), because every item here depends on a dependable chat link.

**Wave 1: autonomy that costs nothing when idle** (each item S)
1. A1 script gate, A2 script-only loops, A3 silence and grouped alerts.
2. B1 `/fire` endpoint and B4 `at` / `on-exit` triggers.
3. F2 scoped grant buttons, F3 learned-escalation offers, F6 `/never`.
4. F7 SDK upgrades: `permission_denials`, `prewarm`, session tags.

**Wave 2: verified, parallel work**
5. C1 checks on every order, plus G1 so each project declares its checks.
6. C2 rubric grader and C3 evidence card.
7. D1 worktree per task and D4 leases.
8. C4 CI and review feedback into the PR's own session, via B2 GitHub triggers.
9. D2 wide dispatch.

**Wave 3: an agent that gets better**
10. E1 correction capture, E2 promotion and demotion in dream, E5 bi-temporal recall.
11. E3 staged skill proposals, gated by H2 prompt regression tests.
12. E4 curator, G2 playbooks, E6 scripts from repeated work.
13. D3 board-driven dispatch, which joins the one-man-company thread's Phase 4.

Wave 1 is mostly scheduler, trigger and governor code, with no new AI paths. Wave 2's biggest risk is worktree cleanup and port allocation. Wave 3 needs memory turned on (`memory.scopes`) to pay off.

---

## 5. What to skip

- **Screen-driving cloud computers** (Grok Bot, Dots, Genspark Claw). They add attack surface and their benchmark scores are similarly low across vendors. The May 2026 browser-agent review measured a 32% rise in indirect prompt-injection content. If browser work is ever needed, copy Stagehand's record-and-replay with scripts as the default.
- **Skill marketplaces** (ClawHub, the Hermes hub with about 90k skills). The ClawHavoc numbers say enough. Keep skills first-party and use E3 to grow them.
- **Agent swarms that report on themselves.** An audit of Ruflo (Claude-Flow) found about 97% of its 300+ MCP tools were stubs, "neural training" returned `Math.random()`, and the tool definitions cost 5–10k tokens per session. Trust only process-level evidence such as exit codes and diffs, which Neo already does.
- **Self-modifying engine code** (Darwin Gödel Machine, SICA). These are fine as research, wrong for a governed engine. Self-improvement stays in skills and memory, behind review.
- **Memory shared across tenants** (Polsia pools anonymised learnings across about 5,900 companies). It clashes with Neo's isolation and its customer firewall.
- **A classifier as the approval authority** (Claude auto mode, Dots auto-review). It would put AI in the engine. Neo's deterministic rules plus scoped grants (F1–F3) get most of the benefit without it.

## 6. Caveats

- Products launched in the last eight weeks (Dots, Muse, Grok Bot, Gemini Spark) are described mostly from launch posts and press. Long-run reliability is unknown for all of them.
- Star counts and versions were checked on 2026-10-04. The Hermes skill-trigger rules, Claude Code "Auto Dream", ChatGPT Work's silent task failures and Harvey's "6x" Outcomes figure are **[unverified]**.
- SDK features in F7 come from the public changelog. Neo pins `"latest"`, so check the installed version before relying on them.

## Sources

**Open source**
- [OpenClaw (Wikipedia)](https://en.wikipedia.org/wiki/OpenClaw) · [OpenClaw heartbeat docs](https://docs.openclaw.ai/gateway/heartbeat) · [Nebius OpenClaw hardening](https://nebius.com/blog/posts/openclaw-security) · [ClawHavoc (Cyberpress)](https://cyberpress.org/clawhavoc-poisons-openclaws-clawhub-with-1184-malicious-skills/) · [OpenClaw + VirusTotal (The Hacker News)](https://thehackernews.com/2026/02/openclaw-integrates-virustotal-scanning.html)
- [Hermes cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) · [Hermes script-only cron](https://hermes-agent.nousresearch.com/docs/guides/cron-script-only) · [hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) · [Hermes ecosystem (Agent Report)](https://the-agent-report.com/2026/06/hermes-agent-188k-stars-90k-skills-ecosystem-june2026/) · [Hermes skills (SSOJet)](https://ssojet.com/blog/hermes-agent-self-evolving-skills)
- [Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute/) · [Letta Code](https://github.com/letta-ai/letta-code)
- [OpenHands events](https://docs.openhands.dev/sdk/arch/events) · [OpenHands 1.18](https://aicybr.com/blog/openhands-1-18-automation-permissions-agent-canvas)
- [goose recipes](https://goose-docs.ai/docs/guides/recipes/recipe-reference/) · [goose scheduler issue #11164](https://github.com/aaif-goose/goose/issues/11164) · [goose issue #10325](https://github.com/aaif-goose/goose/issues/10325)
- [OpenAI Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md) · [Composio orchestrator (Starlog)](https://starlog.is/articles/ai-agents/composiohq-agent-orchestrator) · [Archon](https://github.com/coleam00/Archon/blob/dev/README.md) · [OSS orchestrators (Augment)](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) · [Diagrid durability critique](https://www.diagrid.io/blog/still-not-durable-how-microsoft-agent-framework-and-strands-agents-repeat-the-same-mistake)
- [opencode agents](https://opencode.ai/docs/agents/) · [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) · [Aider repo map](https://anishgandhi.com/aider-pagerank-codebase-ranking/) · [Kiro hooks](https://kiro.dev/docs/hooks/) · [Spec Kit](https://github.com/github/spec-kit) · [Ruflo audit](https://gist.github.com/roman-rr/ed603b676af019b8740423d2bb8e4bf6)
- [Stagehand deterministic agent](https://docs.stagehand.dev/v3/best-practices/deterministic-agent) · [Browser agents 2026](https://michaellivs.com/blog/state-of-browser-use-2026/)
- [Mem0 breakdown](https://memo.d.foundation/breakdown/mem0) · [Zep temporal knowledge graph](https://www.getzep.com/ai-agents/temporal-knowledge-graph/)
- [Darwin Gödel Machine](https://sakana.ai/dgm/) · [SICA](https://github.com/MaximeRobeyns/self_improving_coding_agent) · [Self-evolving coding agents survey](https://arxiv.org/html/2608.03392v2)
- [MCP incidents (UpGuard)](https://www.upguard.com/blog/mcp-security-incidents) · [The lethal trifecta (Willison)](https://simonw.substack.com/p/the-lethal-trifecta-for-ai-agents)

**Commercial**
- [Introducing Dots (OpenAI)](https://openai.com/index/introducing-dots/) · [Dots breakdown (Vellum)](https://www.vellum.ai/blog/official-openai-dots-breakdown) · [Codex cloud environments (TechCrunch)](https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/) · [ChatGPT Pulse](https://openai.com/index/introducing-chatgpt-pulse/)
- [Grok Bot (VentureBeat)](https://venturebeat.com/orchestration/spacexais-grok-bot-turns-agents-into-persistent-digital-coworkers-that-can-operate-your-apps-for-120-per-month) · [Grok Teach-a-Task (Layer3)](https://www.layer3labs.io/guides/grok-bot-teach-a-task)
- [Muse security (Meta)](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) · [Muse address incident (Xenospectrum)](https://xenospectrum.com/en/meta-muse-address-approval-scope/)
- [Manus Wide Research](https://manus.im/blog/manus-wide-research-solve-context-problem) · [Mail Manus](https://manus.im/docs/features/mail-manus)
- [New in Claude Managed Agents](https://claude.com/blog/new-in-claude-managed-agents) · [Claude Code memory docs](https://code.claude.com/docs/en/memory) · [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes) · [Agent SDK TS changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) · [Claude Code Routines guide](https://makerkit.dev/blog/tutorials/claude-code-routines-guide) · [Agent Skills (Anthropic engineering)](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Jules proactive updates](https://blog.google/innovation-and-ai/technology/developers-tools/jules-proactive-updates/) · [Google CC](https://blog.google/innovation-and-ai/models-and-research/google-labs/cc-ai-agent/) · [Gemini Spark (TNW)](https://thenextweb.com/news/google-gemini-spark-agentic-assistant-gmail-io-2026) · [Antigravity](https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/)
- [Devin 2.2](https://cognition.com/blog/introducing-devin-2-2) · [How Cognition uses Devin](https://cognition.com/blog/how-cognition-uses-devin-to-build-devin) · [Devin release notes](https://docs.devin.ai/release-notes/2025) · [Cursor Automations](https://cursor.com/changelog/03-05-26) · [Bugbot Learned Rules](https://cursor.com/changelog/04-08-26) · [Factory guide](https://sidbharath.com/blog/factory-ai-guide/)
- [Lindy review (Saner)](https://blog.saner.ai/lindy-ai-reviews/) · [Decagon simulations](https://decagon.ai/resources/decagon-simulations) · [Sierra Agent SDK](https://sierra.ai/product/agent-sdk) · [Polsia (Henry Shi)](https://henrythe9th.substack.com/p/how-a-solo-founder-cloned-himself) · [Poke (TechCrunch)](https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/) · [Agent 365 (Microsoft)](https://www.microsoft.com/en-us/security/blog/2026/05/01/microsoft-agent-365-now-generally-available-expands-capabilities-and-integrations/)
