# Neo as a one-person company: the operating model (2026-10-04)

Companion to `neo-vs-new-agents.md` (which ranks feature gaps against Dots, Grok Bot and Muse).
This file asks a different question: **what does Neo need so that one person plus Neo behaves like
a small company that ships real work and earns money**, and what should be built first.

## 1. The short answer

Neo today is **session-centric**: an order opens a project, a worker runs, the result streams back.
A company is **outcome-centric**: goals break into work items, owners pick them up, someone checks
the result, money and time are tracked, and the whole thing keeps moving while the founder sleeps.

Everything Neo needs to become a company hangs off one missing spine: **a durable work board**
(goal → work item → owner → verifier → result), owned by the deterministic engine. Departments,
heartbeats, morning briefs, earned autonomy and finance all read from and write to that board.
Without it, each new autonomy feature is another loose loop.

## 2. What the field has learned (evidence, not hype)

| Source | What they found | What it means for Neo |
|---|---|---|
| **Anthropic Project Vend, phase 2** (Claude ran a real shop) | Biggest gains came from **procedures and checklists** ("bureaucracy matters"), better tools (CRM, cost data) and a **specialist agent** (Clothius, merch). The **AI CEO agent made things worse**: it approved requests ~8x more often than it denied them. Staff socially engineered it (a fake CEO "coup", illegal onion futures). | Specialists yes. An AI "CEO" that authorizes, no: authorization stays in engine rules plus Neo. Policy can only change from the operator's channel, never from someone talking to an agent. |
| **Andon Market** (Andon Labs, AI-run SF store, 176 days) | One owner agent (Luna) with five named sub-agents (procurement, email, voice, social, scheduling). ~$4.8k/day revenue, still **not profitable**. Verdict: good **operations manager, not yet a CEO**; weak ROI analysis, memory trouble. A guardrail monitor checks the owner agent against its rules and pages humans on Slack. | Let agents run operations; keep strategy, pricing and spend decisions with Neo. A rule monitor that pages Neo is the right shape (and Neo's governor already is one). |
| **E-Commerce Bench** (arXiv 2608.30730, Sep 2026; year-long simulated merchant) | Huge spread between models; several went bankrupt. **943 of 1,141 fraud losses were repeats** with the same supplier and item. Models rarely used their memory notes and didn't learn to negotiate over repeat orders. | Learning across runs can't be left to the model. The engine must keep hard facts (blocklists, prices paid, past outcomes) and inject them; a model "remembering" is not enough. |
| **Paperclip** (open source, MIT; "zero-human company") | Org chart with roles, reporting lines and permissions; **tickets with goal ancestry** ("agents receive the goal context behind their work"); atomic checkout; **heartbeats** (wake for assigned work, then sleep); budgets per company/agent/project with hard stops; approval gates for hiring, purchases and publishing; revisioned config with rollback; exportable company templates. Its own line: "zero busywork is accurate; zero humans is not." | The closest open-source match to Neo's goal. Steal the ticket + goal-ancestry + heartbeat + budget-per-owner model. Neo already has the stronger governor and firewall. |
| **Polsia** (solo founder, claims ~$1M ARR running 1,000+ AI companies) | A nightly "CEO" instance looks at bugs, business health and paying customers, decides what to do, executes, and sends a **morning summary**. Founders still send ~15 messages a day. | The nightly plan → execute → brief cycle is the product people pay for. Claims are unaudited; treat as a pattern, not proof. |
| **Gas Town** (Steve Yegge, multi-agent coding) | Argues **against** role-play org charts (Analyst → PM → Architect → Dev → QA handoffs). What works: parallel workers in isolated worktrees, **work state kept outside the context window** (beads), deterministic handoffs through git. | Departments should be split by **output** (code, content, sales, finance), not by SDLC phase. Coordination goes through the board and git, not agent-to-agent chat. |
| **Anthropic "Effective harnesses for long-running agents"** | An initializer writes a feature list (all "failing"), a progress file and an init script; each later session takes one item, tests it end to end, commits. Fixes premature "done", lost context and half-finished work. | Each work item gets its own acceptance list and progress file. Neo's `Goal` union (command / judge) is already the verifier. |
| **METR time horizons** (Time Horizon 1.1, Jan 2026) | 50% task horizon of frontier models is several hours and has been doubling every ~3–4 months since 2024. | Work items sized at "a few hours of human work" are now realistic for one worker run; anything bigger must be split on the board. Reliability at 50% means **verification is mandatory**, not optional. |
| **TheAgentCompany** (CMU benchmark, simulated software firm) | Agents do best on coding, worst on tasks needing colleagues, web UIs and admin/finance work. | Start the company where agents are strongest (software, docs, content) and keep human-facing and finance actions gated. |

**The consistent lesson:** agent companies fail at judgment, discipline and learning across time,
not at doing individual tasks. Every one of those is something a deterministic engine can supply.
That is exactly Neo's thesis ("AI decides, the engine acts and governs"), so Neo is better placed
than most of these products. It just hasn't built the company layer yet.

## 3. What makes a "real" agent (and where Neo stands)

| Trait | Chatbot | Real agent | Neo today |
|---|---|---|---|
| Unit of work | a reply | an outcome | an order/session |
| Time | while you're typing | runs while you're away | loops yes; no standing backlog |
| Done means | it stopped talking | a check passed | loops yes (`goal.ts`); dispatch no |
| Memory | none | facts + lessons that change behaviour | Phase 2, off by default |
| Initiative | waits | proposes work, flags risk | only via hand-made loops |
| Money | n/a | knows cost and value of its work | cost meter only, no value side |
| Trust | all or nothing | earned per area, revocable | fixed rules, same for everything |
| Identity | one voice | named roles with their own scope | one company + generic dispatch |

The gaps are in rows 1, 5, 6 and 7. They are all **engine** features, so none breaks the
"no AI in the engine" rule.

## 4. The operating model

Four layers. The engine owns everything in **bold**; workers only propose and execute.

### 4.1 Charter: what the company is for

- `company/charter.md` (gitignored, like all tenant data): mission, current bets, what Neo will
  and won't do, house style.
- **Goals** in the ledger: a short list (3–5) of measurable goals, each with a metric, a target and
  a review date. Example: "Ship v1 of product X to 10 paying users by 2026-12-31."
- **Policies** in `config.json`: spend limits per day and per department, which actions always need
  Neo (publish, pay, email a stranger, deploy to prod), working hours, quiet hours.

### 4.2 Work: the board (the spine)

A `work_items` table in the ledger:

```
id · goal_id · parent_id · title · brief · department · state
· acceptance (Goal: command | judge | checklist) · budget_usd · spent_usd
· blocked_by[] · progress_file · created_by (neo | department) · result · timestamps
```

- **States:** `proposed → approved → doing → review → done`, plus `blocked`, `rejected`.
  **Transitions are engine code**, not prompts. A worker can only move its own item from
  `doing` to `review`. Only a passing verifier moves `review → done`. Only Neo (or a department
  whose earned autonomy covers it, see 4.4) moves `proposed → approved`.
- **Goal ancestry:** when a worker picks up an item, the brief is built from charter → goal →
  parent item → item, so every worker knows why it is doing the work (Paperclip's best idea).
- **Atomic checkout:** one worker per item, using the existing registry; no duplicate work.
- **Per-item progress file** under the project folder (Anthropic harness pattern): the
  context-policy handoff writes to it, the next run reads it first.
- Today's `dispatch` tool becomes "create or update a work item, then run it", so the company
  agent's work leaves a durable trail instead of disappearing into a session.

### 4.3 People: departments, not personas

A department is config, not a prompt costume:

```jsonc
"departments": {
  "engineering": { "folders": ["/home/x/product"], "profile": "dispatch", "memoryScope": "eng",
                   "tools": "default", "budgetUsdPerDay": 8, "cadence": "on-assign" },
  "content":     { "folders": ["/home/x/site"], "budgetUsdPerDay": 3, "cadence": "0 7 * * 1-5" },
  "ops":         { "folders": ["/home/x/ops"], "budgetUsdPerDay": 2, "cadence": "*/30 * * * *" },
  "finance":     { "folders": ["/home/x/books"], "tools": "read-only", "cadence": "0 6 * * *" }
}
```

- Each department = a worker profile + folder fence + memory scope + tool scope + budget + its
  playbooks (skills) + a cadence. Reuses `worker-profile.ts`, `memory.ts` scopes, the governor
  and the loop scheduler; nothing new in kind.
- **Split by output, not by SDLC phase** (Gas Town's warning). No "PM agent" handing to an
  "architect agent". Team mode (`agent-teams.ts`) stays a per-item option inside engineering.
- **The chief of staff (the company project) plans and reports; it never authorizes.** Vend
  showed an AI CEO approving almost everything. Authorization = engine policy + Neo.
- Customer-facing work stays exactly where the firewall puts it: drafts are own-work, sending is
  Neo's approval, direct customer I/O is Gemini. No department changes that.

### 4.4 Rhythm, verification and trust

**Cadence** (all built on the existing loop runtime):

| When | What | Output to Neo |
|---|---|---|
| Heartbeat (per department) | Wake if it has `approved` items or its schedule fires; otherwise sleep (no tokens). | Nothing, unless blocked. |
| Evening plan | Chief of staff reads the board, goals and yesterday's results; **proposes** tomorrow's items. | One message with tap-to-approve buttons. |
| Overnight | Departments work approved items within budget. | Nothing. |
| Morning brief | Done / in review / blocked / spent vs budget / goal progress. Silent rule: if nothing changed, say so in one line. | One message. |
| Weekly review | Per goal: metric vs target. Per department: items done, verifier pass rate, cost per done item. A short retro that **proposes** playbook or CLAUDE.md edits. | One message + proposals. |

**Verification:** every item needs an acceptance check before it can be approved. Code →
`command` goals (tests, build, a smoke script). Content → a `judge` goal plus a checklist from the
department's playbook. Anything outward-facing → Neo's approval is the check. "Done" without a
passing check doesn't exist.

**Earned autonomy (deterministic, per department):**

| Level | May do without asking | Earned by |
|---|---|---|
| L0 | Propose items only | default for a new department |
| L1 | Approve and run its own reversible items (branch, draft, local files) | e.g. 20 done items, ≥90% verifier pass, no incident |
| L2 | Merge to its own repo's main, publish drafts to staging | e.g. 50 items, ≥95% pass, 30 days clean |
| L3 | Outbound within a per-item spend/recipient limit | Neo explicitly grants; never automatic |

The engine computes the level from the outcome record (`outcomes` + `events` tables already
exist). One incident (a reverted change, a denied escalation it tried to route around, a budget
breach) drops the department a level. This replaces "same rules for everything" with trust that
tracks reality, and it's all arithmetic: no AI in the engine.

**Hard facts the engine keeps** (the E-Commerce Bench lesson): a `facts` store of things that
must never be relearned, such as blocked vendors, prices paid, credentials that don't exist,
"never do X" rules from past incidents. Injected into every relevant brief and checked by the
governor where possible (e.g. a blocked domain is denied in code, not just mentioned in a prompt).

**Social engineering defence** (the Vend lesson): charter, goals, policies and department config
change **only** through the operator's authenticated channel (Telegram admin / web console).
Text inside a work item, an email or a web page can request a change but can only create a
`proposed` item for Neo to approve.

### 4.5 Money

- **Cost side** exists (`budget.ts`, `usage.ts`). Add per-department and per-item attribution.
- **Value side** is missing. Port operant's `finance.ts` (already planned for Phase 4) into a
  finance department that reads bank/Stripe exports read-only, keeps a revenue ledger, and reports
  revenue, costs and runway in the weekly review.
- Every goal should have a money or time number attached, so the weekly review can say "this
  department cost $X and moved goal Y by Z".

## 5. What a one-person company on Neo can actually do (realistic, today)

Ordered by how well current agents perform (TheAgentCompany, METR) and how safely Neo can run it:

1. **Run its own software products.** Engineering does the backlog overnight; ops loops watch
   errors and uptime; docs and changelog stay in sync. Strongest fit, already half there.
2. **Agency-style client work** (Neo's own work for clients, which support confirmed is fine):
   engineering builds, the chief of staff drafts status updates, Neo sends. Customer messages go
   through the Gemini path once Phase 3b exists.
3. **Content and distribution:** blog posts, docs, release notes, social drafts from the week's
   real work. Neo approves publishing until the department earns L2.
4. **Back office:** invoices, reminders, bookkeeping reconciliation, renewals, from finance's
   read-only view. Payments always gated.
5. **Research and bids:** market scans, competitor tracking, proposal drafts.

Not yet: anything where an agent negotiates, buys or commits money on its own (Vend, Andon Market
and E-Commerce Bench all show this is where agents lose money).

## 6. Concrete next steps

Each step is a normal Neo phase: spec in `docs/superpowers/specs/`, plan, TDD, green before done.
Step 0 is the prerequisite from the sibling research; a company that drops messages can't run
overnight.

| # | Step | Builds on | Rough size |
|---|---|---|---|
| 0 | Fix the five HIGH Telegram/routing issues (`docs/investigations/2026-07-25-post-update-issues.md`) and close the Codex governor gap. | existing | small–medium |
| 1 | **Work board**: `work_items` + `goals` tables, state machine in engine code, `/board`, `/item`, board tab in the web console. `dispatch` writes items. | `ledger.ts`, `dispatch.ts`, web console | medium |
| 2 | **Verifier-gated done**: acceptance check required at `approved`; `review → done` only on pass. Per-item progress file wired into context handoffs. | `goal.ts`, `context-policy.ts` | small |
| 3 | **Departments as config**: folders, profile, memory scope, tool scope, budget, cadence; heartbeat = wake only when there's approved work. | `worker-profile.ts`, `memory.ts`, `scheduler.ts`, `budget.ts` | medium |
| 4 | **Rhythm**: evening plan with tap-to-approve, morning brief, weekly review with retro proposals. | loops, Telegram inline buttons | small–medium |
| 5 | **Earned autonomy**: compute L0–L3 per department from outcomes; governor reads the level. Incidents demote. | `outcomes`/`events`, `governor.ts` | medium |
| 6 | **Facts store + operator-only policy changes**. | memory, governor | small |
| 7 | **Finance department** (the planned Phase 4 port of `finance.ts`), revenue ledger, goal metrics. | operant `finance.ts` | medium |
| 8 | **Pilot**: one real goal with a number (e.g. a product's next release, or N blog posts and signups), run for 30 days, then judge the model by cost per done item and goal movement. | all of the above | ongoing |

Steps 1–2 alone change how Neo feels: work stops being a stream of chats and becomes a list of
things that are provably done or provably stuck.

## 7. Design rules to keep (so this doesn't drift)

- The engine authorizes, counts and records; workers propose and execute. No AI CEO with power.
- Work state lives on the board and in git, never only in a context window.
- Every item has a check; trust is earned from check results.
- Departments by output, coordination through the board, not agent-to-agent chat.
- Outward, irreversible and money actions stay gated until Neo grants them per department.
- The customer firewall and the zero-tool tainted path are unchanged by any of this.

## Sources

- [Anthropic, Project Vend phase 2](https://www.anthropic.com/research/project-vend-2) · [phase 1](https://www.anthropic.com/research/project-vend-1)
- [Andon Market (Andon Labs)](https://andonlabs.com/market) · [Latent Space interview with Andon Labs](https://www.latent.space/p/andon)
- [E-Commerce Bench, arXiv 2608.30730](https://arxiv.org/pdf/2608.30730)
- [Paperclip on GitHub](https://github.com/paperclipai/paperclip) · [What is Paperclip AI](https://paperclip.inc/blog/what-is-paperclip-ai)
- [Polsia on TeamDay](https://www.teamday.ai/ai/polsia-solo-founder-million-arr-self-running-companies) · [Mixergy interview](https://mixergy.com/interviews/is-polsia-a-250m-scam-i-asked-the-founder-to-his-face/)
- [Gas Town and the two kinds of multi-agent](https://paddo.dev/blog/gastown-two-kinds-of-multi-agent/) · [Gas Town](https://yegge.ai/gastown)
- [Anthropic, Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [METR Time Horizon 1.1](https://metr.org/blog/2026-1-29-time-horizon-1-1/)
- [TheAgentCompany](https://arxiv.org/html/2412.14161v2)

Caveats: Polsia's revenue claims and Andon Market's numbers are self-reported. The E-Commerce
Bench and Andon figures were read from their own pages via a summarizer; check the originals before
quoting numbers elsewhere. Earned-autonomy thresholds in 4.4 are proposals, not measured values.
