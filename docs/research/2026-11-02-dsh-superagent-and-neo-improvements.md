# Research (2026-11-02): dsh-superagent, and what it says about Neo

**Input:** `https://github.com/deepseek-ai/dsh-superagent-prototype` (MIT, read at its default
branch on 2026-11-02). **Checked against:** `master` of this repo as of this date, `CLAUDE.md`,
`docs/HISTORY.md`, ADR-0001…0021, and the October idea map
(`2026-10-04-neo-research-idea-map.md`, whose P0…P8 numbering is reused below).

**One-line verdict:** useful as a design reference, not as code. Read `docs/000`–`docs/003` and
`prompts/` there; ignore `src/`. Part 1 explains why. Part 2 is the Neo work it points at.

---

## Part 1 — What dsh-superagent is

### Facts

| | |
|---|---|
| What | A proactive coding agent for **one GitHub repository**, packaged as a plugin ("bundle") for DeepSeek Harness, DeepSeek's own agent runtime |
| Sources | GitHub (notifications, Issues, PRs, CI, comments) and Feishu (chat). Optional: a web panel |
| Who it serves | A **team**: allowed lists per Source, admission tables, bot lists, a versioned Policy |
| Status | The README calls it a research prototype, "much of the engineering done by coding agents", not identical to DeepSeek's internal version |
| Stack | Node 22+, pnpm, zod, SQLite. Harness coupling everywhere (`@deepseek-ai/cordis`, `dsh-agent`, `dsh-llm`, `dsh-client-*`) |
| Size | ~2.5k lines of docs, ~300 lines of prompts, a client UI, and an engine split into `core/` (domain) and `app/` (glue) |

### Its shape, in Neo words

```
Source (GitHub / Feishu)  → Trigger → Thread
Thread → Eval (gate in code + assessment by the main AI session) → Decision
Decision: accept (creates a Ticket with a Mandate) · stop · ignore · unavailable
Ticket → Assignment → Executor (one AI "worker" session + one worktree per Ticket)
Worker → structured Report (progress · waiting · ready · blocked · failed · dropped)
Ticket ↔ Threads via Subscriptions (later messages reach the worker with no new Eval)
Results → Channel (GitHub comment / review reply / Feishu reply), via a stored outbox
```

The **main Session** is their "company": an AI session that routes requests and relays results
but is forbidden, by prompt, from reading code or writing plans. **Workers** own all technical
work. The host (deterministic code) enforces who may start work, delivers messages, tracks PR
state, retries, and recovers from restarts. That split is the same as Neo's "AI decides, engine
acts and governs", so their field rules transfer.

### What is good about it

- **Philosophy stated as a cost model.** "Take as little human attention as possible, and give as
  much value as possible." Every message, setting and panel element must pay for the attention it
  costs or it is removed. The whole prompt set is derived from that one rule.
- **Few concepts, each with the rules it keeps** (`docs/001-domain.md`), and a table of
  **rejected concepts with reasons**. Neo's `CONTEXT.md` + ADRs do the same job; their table is a
  good format to borrow.
- **Honest state tables.** A Ticket stage is "the first matching row wins" over structured facts
  (`docs/003-execution.md`). This is `deriveThreadState` in Neo, applied one level lower, to each
  unit of work.
- **Worker reports are a schema, not prose.** `ready` means "self-reviewed, checks passed"; an
  incomplete draft is `blocked`, never `ready`; `dropped` closes silently; `pr_number` must be real
  or null, "never a placeholder such as 1".
- **The PR lifecycle is owned end to end.** A Ticket follows the PR it opened; CI results and review
  comments route back to the same worker; fixed review threads are resolved silently; declined
  suggestions get one factual reason in the thread; bot reviewers are capped at three rounds; the
  worker reports ready **without waiting for merge**; the host sends one merge/close notice.
- **Observe mode.** Proactive rules start by recording what the agent *would* have done
  (`observe`), and switch to `auto` only after a person has read those records.
- **Communication rules that are testable.** One sentence per result (outcome, link, next action),
  100 words hard ceiling, and the editing test: *would deleting this clause prevent the person from
  understanding the result or taking the required action? If not, delete it.*
- **Restart recovery.** An interrupted assignment restarts with a note: check your directory, git
  history and GitHub before repeating any outside action.
- **Stored work.** Everything the host does after a decision (relay, launch, deliver, reply) is
  stored first and done afterwards, retried with backoff, ordered per ticket per conversation.

### What does not fit Neo

| Theirs | Why not |
|---|---|
| Source / Trigger / Eval / Mandate / Policy version / admission tables / allowed lists | Team authorization. Neo has one operator; the Telegram admin gate and the firewall already answer "who may start work" |
| Feishu | No use |
| DeepSeek Harness coupling (plugin manifest, `cordis`, `dsh-llm`, harness presets) | Neo runs on the Claude Agent SDK (or Codex); nothing in `src/` ports |
| One repository per deployment | Neo is many projects under `/home` |
| The panel | Neo has the operator console, the Decisions channel and `/trace` |
| Auto-merge via a second GitHub account, reviewer crediting by `filter-branch` | Operator merges; loops never push (standing rule) |
| The main Session as a pure router that writes no plans | Neo's company **writes the brief** by design. Part 2 takes the lesson without the rule |

### Where to look, if you open it

- `docs/000-philosophy.md`, `docs/001-domain.md`, `docs/003-execution.md` — the design.
- `prompts/work.md`, `prompts/replies.md`, `prompts/team/communication.md`,
  `prompts/team/delivery.md`, `prompts/team/scope.md` — the field rules workers actually run under.
- `prompts/admission.md` — the "three facts before accepting unasked work" gate.

---

## Part 2 — How to improve Neo

Status: **Done** · **Partial** · **Missing**. Verdict: **Keep** · **Merge** (into an existing plan
item) · **Spike** · **Drop**. Priorities reuse the October map's P-numbers where they apply.

### 2.1 Map: dsh-superagent idea → Neo today

| # | Idea | Neo status | Where it lives today | Verdict |
|---|---|---|---|---|
| 1 | Worker ends with a **structured outcome report** (ready/blocked/failed/dropped + evidence) | Partial | `dispatch-report.ts` builds the result from engine facts (exit, stop point, last commit) + the worker's prose; `ask_operator` is the only schema'd worker→engine channel | **Keep** → P3 (research C3, now with a shape) |
| 2 | **Ticket follows its PR**: CI + review comments route to the worker that opened it | Missing | `producers/github.ts` turns PR state into attention items for the operator only; `reply-routing.ts` can resume a folder's session by id | **Keep** → P5 (research C4), the biggest coding gap |
| 3 | Review etiquette: resolve fixed threads silently, one reason for a declined suggestion, cap bot-review rounds, ready ≠ merged | Missing | — | **Merge** into #2 |
| 4 | **Original request always travels with the assignment**; the router adds routing facts only, never requirements | Partial | the company writes a tailored brief (`dispatch.ts`); the operator's verbatim order is in the ledger but not in the brief | **Keep** → P3 |
| 5 | **Handback**: a worker returns an out-of-scope follow-up to the router with a reason | Missing | a follow-up to a focused project lands in that session whatever it asks (`registry.ts` focus, `pipeline.ts`) | **Keep** → P3 |
| 6 | **Observe mode** for proactive work | Missing | loops run or do not run (`loops.ts`, `loop_defs`) | **Keep** → P1 (beside the `LoopDef.gate` work) |
| 7 | Result messages: one sentence, link, next action; evidence stays in the PR / internal report | Partial | priority routing exists (`priority.ts`); result *content* is whatever the company summarises | **Keep** → P2 (prompt + renderer rule, cheap) |
| 8 | Acknowledge once, specifically ("On it: changing X to Y"), then silence until a result or a question | Partial | dispatch confirms "dispatched to X"; no specific acknowledgement of *what* was understood | **Merge** into #7 |
| 9 | **Worktree + branch per unit of work**, PR bound to the task by branch name | Missing | todo queue is serial per project (ADR-0008); updater already uses a worktree | **Keep** → P6 (research D1), with the branch-naming rule |
| 10 | **Restart recovery note** to a resumed worker | Partial | boot recovery reports the stop point to the operator (ADR-0007/0008); the re-dispatched worker gets no warning | **Keep** → P1 (one preamble line) |
| 11 | Background shell jobs that **wake the worker on exit** | Missing (harness) | Neo forbids background waits so the stall detector stays honest (`briefWithProjectDocs`) | **Spike** (see 2.3) |
| 12 | Interactive slot: a person's message always gets a worker slot | Done | interactive reserve by originating trigger (ADR-0001 + follow-up), company always free | — |
| 13 | Stored outbox, retry with backoff, per-conversation ordering | Done | dispatcher inbox, Telegram flood gate, `faults` dedupe (ADR-0010) | — |
| 14 | Derived stage tables, "first matching row wins" | Done | `liveness.ts`, `thread-state.ts`, `session-status.ts` | — |
| 15 | Rejected-concepts table in the domain doc | Partial | ADRs record rejected alternatives per decision | **Keep** → add one table to `CONTEXT.md` (docs only) |
| 16 | Three facts before accepting unasked work (targets this project · intent for a specific change · direction settled); design debate never becomes a ticket | Missing | nothing reads issues/threads as triggers yet | **Defer** until an issue- or inbox-driven trigger exists (P1 gate / Phase 3b) |
| 17 | UI change ⇒ **before/after** evidence in the PR, same scenario and viewport | Missing | Playwright MCP is on every operator worker now | **Keep** → P3 (one preamble rule) |
| 18 | Policy change delivered to live work as an input, never cancelling it | n/a | no team policy | **Drop** |

### 2.2 The proposals, in order

**A. A structured end-of-work report (P3).** Today the engine *infers* a dispatch's outcome. Make
the worker *declare* it through one engine-owned tool, the way `ask_operator` already declares a
decision: outcome in {ready, blocked, failed, dropped}, a one-line user-visible summary, what was
verified (commands actually run, pass/fail), the PR or commit reference or null, risks, and what
remains if not ready. The engine keeps every fact it observes today (stop point, cost, last commit)
and adds the declared report beside it; where they disagree (worker says ready, tree is dirty, tests
did not run) the engine says so. Effects: "draft" and "done" become different states by schema, not
by reading prose; the todo queue's `todoOnFailure` can act on `blocked` vs `failed`; the secretary
and `/trace` get a real outcome field; the result line (proposal C) renders from fields. Rejected:
parsing the worker's last paragraph for the outcome (that is the inference being removed). Seam:
the same choke point as `ask_operator` in `dispatch.ts`; a required final call, with the engine's
existing "settled" end as the fallback when a worker ends without one (reported as *unreported*,
never as *done*).

**B. Own the PR to the end (P5).** Record which project session opened which PR (branch →
session/todo binding, ADR-0008's todo row is the natural owner). Then route three kinds of GitHub
events back into that session as inputs instead of only into attention items: a failed check, a
human review comment or change request, and a merge/close. Carry dsh-superagent's etiquette into
the preamble: fix and resolve a thread silently, decline with one factual reason in that thread,
never a top-level "fixed everything" comment, at most N rounds with an automated reviewer, report
ready without waiting for merge, and send the operator exactly one notice when the PR merges or
closes. The engine side is deterministic (the GitHub producer already polls; add "deliver to the
owning session" next to "open an attention item"); the AI side is the worker reading the event.
Rejected: a separate "PR babysitter" loop per PR (a second implementation of what the owning
session already knows).

**C. Result and acknowledgement rules (P2).** Two prompt rules and one renderer rule, no new
machinery. (1) When the company dispatches, its first line to the operator names the change it
understood, specifically. (2) A result to the operator is one sentence: user-visible outcome, link
or commit, necessary next action; a second sentence only for a blocker that changes what the
operator can do. Technical evidence stays in the dispatch report and `/trace`. (3) The renderer
applies the deletion test as a length cap, not a style guide. This is where Neo's own "be concise"
convention becomes checkable.

**D. The verbatim order rides with the brief, and workers can hand back (P3).** Keep the company's
tailored brief, but the engine appends the operator's original message verbatim under a fixed
heading, so the worker can check the brief against the source and "a routing note never
substitutes for the original context". Add a `handback` outcome to the report in A: a worker that
receives a follow-up outside its brief returns it with a reason, and the engine delivers it to the
company as a candidate instead of leaving it to be absorbed or dropped. Today one-shot focus means
the next stray message goes to the company anyway; handback covers the case where the message *did*
reach a project and did not belong there.

**E. Observe mode for loops (P1).** A loop definition gains an `observe` flag (default on for a
newly created loop, off for built-ins). An observed fire runs the worker read-only (the governor's
`READONLY_DENY` set already exists), records what it would have changed as its report, and sends
nothing but the report to the operator. Flipping it off is an operator tap, which is the same
"widen only by operator action" rule the October map kept. Rejected: a dry-run flag on dispatch
(dispatch is operator-ordered; observe is for unasked work).

**F. Worktree per todo, branch names bind PRs (P6).** When a project is busy and a second todo
arrives, the engine may create a worktree and a branch named after the todo id (operator opt-in per
project, as research D1 said). The PR-to-owner binding in B falls out of the branch name, exactly as
dsh-superagent binds a PR to a ticket by its branch's last path segment. The worktree is removed
when the todo ends (standing rule: worktree folders are temporary).

**G. Restart recovery note (P1).** One preamble line, added only when a brief is a resume or a
re-dispatch after an abnormal end: "This work was interrupted. Check the working tree, git log and
GitHub before repeating any outside action (push, PR, deploy, message)."

**H. Before/after evidence for UI changes (P3).** One preamble rule: a change that alters what a
user sees ships with a before and an after capture of the same scenario, viewport and state, taken
with the Playwright MCP; after-only is incomplete and must be reported as such. Fits the
engineering-baseline slot in `briefWithProjectDocs` (watch the 5000-char ceiling test).

### 2.3 One spike

**Does a headless Agent SDK session get re-invoked when a background Bash task exits?** In
dsh-superagent the harness moves any shell command over five seconds to a background job and wakes
the worker when the job ends, so a worker never polls. Neo solved the same problem the other way:
it bans background waits so the stall detector keeps seeing events. If the current SDK does wake a
session on background-task exit (the CLI does this interactively), the no-background-wait contract
could be relaxed for long builds and test runs, and the stall clock could treat an in-flight
background task the engine *knows about* as alive. If it does not, keep the contract and record the
answer in `docs/sdk-notes.md`.

### 2.4 What stays as it is

- The firewall and the subscription decision. Nothing above touches customer paths; all of A–H
  attach on operator paths only, like `ask_operator`.
- No AI in the engine. Every proposal is either a prompt rule, a schema at a tool boundary, or
  deterministic routing over the ledger.
- The company writes briefs. D keeps the brief and adds the source beside it; it does not turn the
  company into a pure router.

### Suggested order

C and G first (prompt-only, a daemon restart each). Then A, because B, D and E all want the
structured outcome. Then B. E can go in parallel with B. F last, when parallel work on one project
is actually wanted. H whenever the next preamble edit happens.
