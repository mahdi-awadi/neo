# Neo vs Dots, Grok Bot, Muse: what to learn (2026-10-04)

## Neo today (from the repo, `master` @ 60b87b9, last commit 2026-07-28)

- **What it is:** a deterministic engine (Bun + TypeScript, no AI inside) that opens your project folders as governed headless workers. The default worker is the Claude Agent SDK; the OpenAI Codex SDK is optional. You drive it from Telegram or a web console.
- **Governance:** a default-escalate governor (`src/engine/governor.ts`) does three things:
  - fences file writes to the project folder;
  - asks you before unknown or foreign MCP tools, WebFetch, or writes outside the folder;
  - gives zero tools to drafting that touches customer text.
- **Compliance firewall:** customer-direct work is refused onto the Claude subscription in code (`provider-router.ts`).
- **Company and projects:**
  - an always-on "company" project dispatches work to sub-workers, with stall monitoring and opt-in agent teams;
  - a one-shot per-message project focus, plus `/pin`;
  - idle-close and resume;
  - context-policy handoffs;
  - graceful `/reload`.
- **Autonomy:** `trigger → action → goal` loops. Triggers are only manual, interval or cron (`src/engine/trigger.ts:6-8`), with goal checks and budget bounds. You can create, edit and delete loops from the web console.
- **Memory (Phase 2, default off):**
  - capped MEMORY.md and USER.md files, injected as a frozen snapshot when a worker starts;
  - FTS5 recall with citations;
  - a nightly "dream" consolidation loop.
- **Other:**
  - customer inbox with approval-gated send;
  - budget meter that reserves interactive headroom;
  - API rate-limit backoff;
  - engine event log (`/events`).
- **In flight:**
  - The repo has no open PRs or issues, and no branches except master.
  - Planned in docs but not built:
    - security audit, scheduler hardening and model failover (Phase 4);
    - heartbeat, commitments, more trigger types and queue modes (Phase 5);
    - all in `docs/superpowers/specs/2026-07-23-hermes-openclaw-upgrades-design.md`;
    - the Gemini customer path (Phase 3b).
  - The 2026-07-25 investigation (`docs/investigations/2026-07-25-post-update-issues.md`) lists 7 reliability issues. Five are rated HIGH:
    - follow-ups only land at turn end;
    - Telegram sends are dropped or arrive out of order;
    - a typed reply can't answer an Allow/Deny prompt;
    - a reply can land in the wrong project;
    - backoff can park a worker for hours.
  - Inferred: no commit since then targets those five (later commits are the event log, an approval-bridge fix and the Codex adapter).
  - The Codex adapter has no `canUseTool` hook, so Codex runs skip Neo's governor (HISTORY.md, "Worker SDK wrapper").

## The new agents in one line each

- **Dots (OpenAI, launched 2026-09-29):** always-on agents working toward goals in the background. One main Dot plus specialist Dots, each with its own identity, credentials and tools. It runs in Slack and Teams, with SMS coming. Its memory and approval model are not public yet.
- **Grok Bot (xAI, August 2026):** runs 24/7 on a persistent cloud computer and uses apps through their screens.
  - "Teach-a-Task" turns one demonstration into a routine that improves from your corrections.
  - It remembers preferences, resumes dropped work, and has a "Chief of Staff" Bot coordinating the others.
  - Grok Tasks run on a schedule or an incoming-email trigger. You create them in plain chat, and each keeps its own history.
- **Muse (Meta, around 2026-09-08):** turns goals into plans and keeps working after you close the app, coming back when something changes or it needs approval.
  - A separate **Sentinel** agent approves every action that goes out to the internet.
  - It runs in a secure VM, and you choose read-only or send access for each app.
  - You can tell it to "forget" things. It runs in WhatsApp and the Muse app.
- **For comparison:**
  - Hermes Agent: memory files, built-in cron, and skills it writes itself.
  - OpenClaw: Skill Workshop turns corrections into skills, with a "propose" mode.
  - Poke: proactive morning briefings over iMessage, SMS and Telegram.

## How Neo compares

Neo already matches or beats them on:
- governance enforced in code;
- working in your own folders on your own server;
- loops with a verifiable goal, which none of them advertise;
- memory built the Hermes way.

Neo is behind on three fronts:
1. It does not feel always-on: nothing proactive happens unless you set up a loop.
2. Its chat link is not dependable: the open HIGH issues above.
3. Making automations and skills takes developer effort. The others let you do it from chat, by teaching or by correcting.

## Top improvements, ranked by impact

1. **Make the Telegram loop dependable (fix open issues 1, 3, 4, 5, 6).**
   - Every rival's core promise is "it works while you're away and comes back when it needs you", and Neo breaks exactly there.
   - Fixes:
     - deliver follow-ups mid-turn (the planned `steer` queue mode);
     - add send retries and Telegram flood-control handling;
     - let a typed reply answer Allow/Deny;
     - route a reply to the project it answers.
   - Cheap, because the event log now makes these diagnosable.
2. **A heartbeat and morning brief with a silence rule (spec items 12–13).**
   - This is what Muse, Poke and Dots sell: the company project reviews the inbox, running sessions and commitments, then either stays silent (`HEARTBEAT_OK`) or pings you. Add a daily brief and commitment check-ins.
   - It reuses the loop runtime and memory, which already exist. Memory must be turned on (`memory.scopes`) for it to pay off.
3. **Create automations from chat, with richer triggers (Grok Tasks, spec item 14).**
   - Let the company propose a loop from "every weekday at 9, check X" and confirm it with one tap.
   - Add `at` (one-shot) and `on-exit` triggers.
   - An email-arrival trigger has to stay tainted: zero tools, or the Gemini path. It must never put customer text into a tooled Claude worker.
   - Keep the planned rule that scheduling can never widen tool access.
4. **An outbound-action gate for each connector, and closing the Codex gap (Muse Sentinel and per-app scopes).**
   - Replace "escalate every foreign MCP tool" with a config table that gives each MCP server or tool `read`, `send` or `deny`. Reads then flow and only outbound actions ask.
   - The gate stays deterministic, not an AI judge, to keep "no AI in the engine".
   - Before Codex is used for real work, map Neo's policy onto Codex's sandbox and approval settings (at minimum read-only, or a folder-scoped workspace-write), because today it bypasses the governor.
   - Ship the planned `/audit` command alongside.
5. **Turn corrections into skills, as proposals (OpenClaw Skill Workshop, Grok Teach-a-Task, Hermes).**
   - When a session ends after you corrected it, the worker drafts a skill or CLAUDE.md change, and you approve it on Telegram.
   - The AI stays in the worker; the engine only stores and gates. This puts the CLAUDE.md rule "skillify anything done more than once" into the product.
6. **Named specialist workers with a persistent identity (Dots teams, Grok's Chief of Staff).**
   - Turn dispatch profiles into named "departments": each has its own worker profile, memory scope, tool scope and loops, and the company acts as chief of staff.
   - This is the natural shape for Phase 4 (finance/board) and reuses `agent-teams.ts` and `worker-profile.ts`.
7. **Memory controls you can see (Muse "forget").**
   - Commands to show memory, forget something, or pin it, from Telegram.
   - Small to build, and it makes it easier to turn memory on by default for the company.

**Skip:** avatars, voice, computer-use cloud VMs and a skill marketplace. The existing spec already rejects these for good reasons, and Grok Bot's screen-driving and Dots' credential sprawl add the attack surface Neo was built to avoid.

## Caveats

- Dots, Grok Bot and Muse are only weeks old, so most details come from press coverage, not official docs.
- Dots' memory and approval model are unverified. Grok in Telegram is unverified (one weak source).

Sources: [TechCrunch on Dots](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/) · [Axios on Dots](https://www.axios.com/2026/09/29/openai-dots-ai-assistant-devday) · [VentureBeat on Grok Bot](https://venturebeat.com/orchestration/spacexais-grok-bot-turns-agents-into-persistent-digital-coworkers-that-can-operate-your-apps-for-120-per-month) · [Layer3 on Grok Bot](https://www.layer3labs.io/guides/what-is-grok-bot) · [Meta on Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) · [Axios on Muse](https://www.axios.com/2026/09/08/meta-debuts-muse-personal-ai-agent) · [Hermes Agent](https://github.com/nousresearch/hermes-agent) · [Composio: OpenClaw vs Hermes](https://composio.dev/content/openclaw-vs-hermes-agent) · [Poke](https://theaiagentindex.com/agents/poke)
