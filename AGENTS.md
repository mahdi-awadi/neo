# Agent instructions

This project's working instructions live in **[CLAUDE.md](./CLAUDE.md)** — read it first. The
phased build plan is in **[MVP-PLAN.md](./MVP-PLAN.md)**.

TL;DR: Neo is a deterministic engine that fires project work to the Claude Agent SDK. The engine
contains no AI. Build phase-by-phase with TDD; keep `bunx tsc --noEmit` and `bun test` green; port
proven code from `/home/operant` but never its tmux/socket/scraper layer.
