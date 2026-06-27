# Neo

A personal work **engine**. You give it an order ("open this project and do X"); it opens the
project as a headless Claude Code worker via the **Claude Agent SDK**, governs the work
deterministically, and streams progress back to you on a channel (Telegram first). No `cd`, no
terminal, no tmux.

## Architecture (three layers)

```
Frontend  (Telegram / email / WhatsApp)   ← you talk to projects here
   ↕
Engine    (orders · provider routing · governance · budget · ledger)   ← deterministic. no AI.
   ↕  query(task, { cwd, canUseTool, mcpServers, settingSources })
Worker    (Claude Agent SDK = Claude Code in a project folder)   ← does the work
```

AI **decides**; the engine **acts and governs**.

## Provider model (compliance firewall — enforced in code, not prompts)

- **Your own work → your Claude subscription**, via the Agent SDK. It draws from your normal
  subscription usage limits today (the monthly-credit change is paused; see the plan). Provider
  choice is config-driven so a future plan change is a config flip, not a rewrite.
- **Customer-direct work (email/WhatsApp/web) → Gemini.** A customer never touches the
  subscription, and Neo never offers customers a Claude login.
- **Budget guard:** background SDK work shares your subscription pool, so the engine reserves
  interactive headroom — it must not drain the plan you use yourself.

## Status

Phases 1–3 complete: the order → open → govern → stream engine, live follow-ups + resume + budget,
and an operator **web console** (`neo.tech-gate.online`) alongside Telegram. On top of that, a
**loop runtime** (trigger → action → goal) now runs scheduled/manual autonomous loops through the
governed worker, and a **customer inbox** queues inbound mail for operator review (no auto-reply).
Next: data-driven loop CRUD (spec'd) and the Gemini customer path (Phase 3b). See `MVP-PLAN.md` for
the phased plan and `docs/loops.md` for the autonomy model.

## Run

```bash
bun install
bun run src/daemon.ts   # serves the Telegram bot + web console + loop scheduler
bun test ./tests/*.test.ts   # Neo's suite (239 green)
bunx tsc --noEmit            # typecheck
```
