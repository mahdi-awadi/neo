# HANDOFF — 2026-10-29: self-explaining attention items and todos (ADR-0059, ledger v15, on dev, restart-gated)

Attention items carry facts (producers write them; old rows derive them) and render as badge + project + plain
title + reason + links + next step + brief, EN/AR. → todo works for every GitHub/git kind. Todos have a summary
(deterministic, then an accepted haiku line; config `todoSummary`). The restart runs migration v15.
Screenshots: /home/neo/agent/attention-*-2026-10-29.png.

---

# HANDOFF — 2026-10-29: standing rules + planner subagent (ADR-0063, on dev, restart-gated)

Every dispatch/todo/plan-execution brief, loop iteration and consult run now carries the five standing
rules (one text, `src/engine/standing-rules.ts`). Dispatch, project and loop runs get a `planner` subagent
(config `planner`, default the pinned Opus id at effort `max`) for the DESIGN phase and the final review.

---

# HANDOFF — 2026-10-29: `project_message` tool (ADR-0061, on dev, restart-gated)

The chief of staff can speak to a project's open session like the operator ("resume", "status?") through the
same delivery path. Tool card `docs/tools/project-message.md` (scope: agent; picked up by
`bun tools/catalogue/install.ts`). `agent/CLAUDE.md` (local) says when to use it vs dispatch vs notes.

---

# HANDOFF — 2026-10-29: limit-held todos resume with `todo retry` (ADR-0060, on dev, restart-gated)

Built on `dev`: `todo retry` on a running todo held in a limit or API retry wait re-sends its brief into the
same session now (no second run); a turn that goes through sends a pending re-send at once and wakes the
account's other limit holds; `/todo`, the Queue tab and `sessions` show the hold. `agent/CLAUDE.md` (local, untracked)
tells the chief of staff to use `todo retry`, never `/kill`. Held today: eticket-v3 #811, adminli #829,
waselni #833, cpahost #831 — the running build cannot wake them; after the restart, a held run starts fresh
anyway (interrupted orders, ADR-0054).

---

# HANDOFF — 2026-10-29: tools catalogue learns from use (ADR-0044 P3–P5, on dev, restart-gated)

Built on `dev` (operator picked it on decision #4a2a44ca): usage ranking from done orders (ledger
adapter), Skill calls labelled with the skill name, four recipes, the daily skillify producer, the
`tools-enrich` loop definition with `tools/catalogue/misses.ts`, the preamble pointer. ADR-0044
Amendment 2 records the as-built decisions (the loop goal is `misses.ts check`, not the catalogue
test). Operator steps after the merge + restart: `bun tools/catalogue/install.ts` (writes the
`neo-tool-*`/`neo-recipe-*` skills into `~/.claude/skills`), and, when wanted,
`bun tools/create-loop.ts docs/loops/tools-enrich.json` then enable it. Task 13 (ScaleDown pilot) stays
operator-gated.

---

# HANDOFF — gateway Traefik host (2026-10-29, note #455)

`neo-gateway` was recreated from the `dev` compose file with `NEO_API_HOST=neo-api.tech-gate.online`
(set in `gateway/.env`). **Until `dev` is merged to master, do not recreate the gateway from
`/home/neo/gateway`:** master's compose file still has the `neo-api.example.com` placeholder and would
bring back the 400 ACME loop. Use
`docker compose -p gateway -f <dev checkout>/gateway/docker-compose.yml --project-directory /home/neo/gateway up -d neo-gateway`.
`gateway/worker/wrangler.toml` still has the public placeholder `GATEWAY_URL`; the deployed Worker's
own value was not changed (it needs Cloudflare access).

---

# HANDOFF — 2026-10-29: open engine work finished on dev (restart-gated)

Built on `dev` (not live; needs merge to master + restart):
- **ADR-0058 Stop/Background one tool call** — plan `2026-10-28-tool-call-control.md` fully built:
  SDK spike (sdk-notes), tracker + marker (`tool-calls.ts`, governor hook), `proc-tree.ts`,
  `docker-exec.ts`, `tool-control.ts`, `/stop` `/bg` `/list`, company `tool_control`, console strip,
  Telegram notices, plus the security-review fixes. Config `toolControl.*`.
- **Reach plan P0.3–P0.5** — guard SSH keys (re-install the kit: `bun tools/security/install.ts`, an
  operator step), `mcp__neo__` trusted by `mcpServer.source`, constant-time bearers +
  `INBOX_INGEST_SECRET`. The rest of the reach plan waits on its 11 operator decisions.
- Earlier on dev: side lanes (ADR-0057, ledger v14), long checks in the background (ADR-0055), logo +
  splash (ADR-0056). Master is still `b3295df`.

Not built (why):
- Reach plan P0.1/P0.2 spikes, P1–P5, P0.6 host hygiene: production access, deploys and 11 operator
  decisions (§12); outside "dev work".
- ADR-0044 tools catalogue P3–P5: now built on `dev` (see the section at the top).
- Plan-watch misses plans written in a worktree: the plan lives on another branch until merged, so the
  fix needs a design choice (which folder and branch own the card); not a two-line fix.
- Claude-app parity and research P0–P8 plans: product plans awaiting scope approval.

Security triage: the "new" medium findings on `app.ts` (`neo-js-raw-html`) are false positives. Every
dynamic value goes through `esc`/`ltr`/`iso`/`t`; the lines moved, so their fingerprints changed.
The baseline is untouched.

---

# HANDOFF — side lanes (ADR-0057): built on dev, restart-gated

The operator approved the plan `docs/superpowers/plans/2026-10-28-side-lanes.md` (2026-10-28) and it is
built: commits 802a4e1, 81070ac, 53d4057, 96dd789, cddaed4, 8db5f68, fb4f8aa, 77f83d7 (review fixes).
Full `bun test` is green (2,385 pass) and `tsc` is clean. Not live: it needs merge + restart (ledger
v13 → v14).
- The chief of staff's rules are in `agent/CLAUDE.md` ("Side lanes"; untracked, edited in place). Until
  the restart, the running engine ignores `lane`, so briefs just queue.
- Off switch: `lanes.enabled: false` in config.json.
- Known limits (ADR-0057): the Bash text reader does not see interpreters, `$VAR` paths, `make`,
  `npm install`, `curl -o`. A `code` lane cannot run a dockerized stack.
- Engine gap found (not fixed): the plan watcher only registers plans written inside the run's own
  folder (`plan-watch.ts:47`). A plan written in a worktree (`/tmp/...`) gets no card.

---

# HANDOFF — waiting work (ADR-0054): LIVE since 2026-10-27

Released on operator approval #117ff497: master fast-forwarded to d85b638 and booted 2026-10-27 03:51
(`engine_boots` head d85b638, branch master, ledger v13, no faults). The `waiting-sweep` loop is
loaded (hourly). `settle-decisions` was applied on decision #9ee6123d: 38 cards closed, 4bb30cac and
666f1438 kept with the new `--keep` flag (backup `data/ledger.db.bak-settle-2026-10-27T05-41-26-015Z`);
a second dry run closes 0. Plan `2026-10-27-waiting-work-ship-and-settle.md` is fully ticked.

On `dev` after the release (restart-gated, not live; master not moved):
- f281544, 96df985: `settle-decisions --keep <id>,<id>` (tool only; no restart needed to use it).
- 84ad3c5: a loop's judge run counts toward `budgetUsd`; the goal's `timeoutMs` aborts the judge.
  Needs a restart.

Still open (operator):
- /home/neo is on `master` (the approved release). A 2026-10-27 reload note says the operator wants it
  kept on `dev`: confirm which branch the folder should stay on.
- ADR-0050 rollout steps 3–6 (tool skills install, worker env strip, relay, remote branch delete).
- ADR-0044 Phases 3–5 (usage ranking, recipes, skillify, enrichment loop) are not approved.
- Plans awaiting approval: claude-app feature parity, research P0-P8.
- todo #700 duplicates a built plan; 5 stale `chore/agent-sdk-*` branches; the open real questions.
- Many older plans (June–October) still show unticked boxes for work that is built; not audited.

Tests: under load avg 80–220 the full suite gives 2,301–2,304 pass with 3–10 timing failures, each
passing alone or with `--timeout 30000` (one also fails on master under the same load).
---

# HANDOFF — decision threads and closing (ADR-0053): on `dev`, restart-gated

Bugs: (A) the dispatcher filed new work under the last ended turn's thread (`pipeline.ts`
`turnCause`/`runCause` → `lastCauseOf`); (B) a thread's stored state was not re-derived when a
decision closed (`plans.ts` dismissed the old card silently); (C) plan cards closed only through their
buttons, and a todo parked on a card waited forever. Fix in ADR-0053 / spec
`docs/superpowers/specs/2026-10-26-decision-threads-and-closing.md`.
Operator steps after the restart onto `dev`: run `bun tools/threads/settle-decisions.ts
data/ledger.db` (dry run), check the list, then `--apply` (it refuses on a ledger older than the code).
The keep-open list (prod/irreversible questions, awaiting plans) still needs the operator's answers.

---

# HANDOFF — a session held at a big plan takes no brief (ADR-0052): on `dev`, restart-gated

Bug: a todo for a folder whose live session was held at a big plan (ADR-0036) was delivered into it
and marked `done` at once; the worker could only answer STOP (contantme #659/#660/#665/#666/#680).
Fix: `SessionControl.held()` from the plan watch; dispatch refuses (`plan_held`); `projectBusy`
counts a held session busy, so the todo waits `queued` and starts once the hold lifts;
`clearDecisionBlock` keeps a plan hold's block. Needs a daemon restart to go live.
Still open: contantme plan #1645 (master plan) waits for the operator's Approve & build / Drop.

---

# HANDOFF — security kit fixes (ADR-0051): on `dev`, not installed

Two fixes to `tools/security/`, found while turning the kit on in eticket-v3. Commits on `dev`:
`007c038`, `03f8645` and `7dd162a`, plus the docs commit.
- Semgrep runs in parts (`semgrepChunkFiles`, default 200), each under `semgrepTimeoutSec` (default
  1800), per repo in `.security/config.json`. A part with no result is recorded as missing:
  `baseline.json` and reports get an `incomplete` list, and later layers warn against an incomplete
  baseline.
- A recorded chained hook that is missing or not executable exits 1 (it was exit 0). A `.git/hooks`
  chain is found through the common git dir, so it runs from a linked worktree too.
- Checks: `tsc` clean; `bun test` 2255 pass, 0 fail; push scan of the 3 commits: 0 high/critical.

Operator steps: re-install the kit (`bun tools/security/install.ts --host-env dev`, from a `dev`
checkout); in eticket-v3, set `semgrepTimeoutSec`/`semgrepChunkFiles` if needed, re-run
`bun ~/.claude/security/init.ts /home/eticket-v3`, then `bash ~/.claude/security/scan.sh baseline
/home/eticket-v3` and check that `incomplete` is `[]`; re-run `init.ts` on every other repo that has
the kit, so its hooks get the fail-closed template.

---

# Earlier: agent questions + live notes (ADR-0050) and tools catalogue (ADR-0044 P1–P2): on dev, restart-gated

## Done (merged to `dev`; branch `feat/agent-messaging` kept; worktree removed)
- **Tools catalogue (ADR-0044 P1–P2):**
  - cards in `docs/tools/` with a validator test;
  - `tools/catalogue/install.ts` (tool skills);
  - the `tool_api` relay: fail-closed, capped per project, key redacted from replies;
  - `tools_for` and the dispatch tools hint.
- **Worker env scrub** (`src/engine/worker-env.ts`):
  - relay keys are always removed;
  - Neo's env-file key NAMES are recorded once per start as `worker_env_report` (mode `report`);
  - `strip` exists but is off.
- **Follow-up timing** (port of `c12c46f`): `followUp(text, "steer"|"after-turn")`.
  - The operator's words steer at the next step; engine briefs wait for the turn.
  - Verified on SDK 0.3.292 (`docs/sdk-notes.md`).
- **`project_notes ask`:**
  - a question to `main` (the company folder only) or a project;
  - answered by a read-only consult run (`src/engine/consult.ts`) that forks only an idle,
    known-Claude session, has no codebase-memory, can be aborted on a stall, and spends on the
    budget meter.
- **Live notes:** notes from main and late answers reach a running worker at its next step, quoted
  as data. They never wake an idle session.
- **Ledger:** migration v13 adds `answer`, `delivered_at`, `from_session` to `attention_items`.
- **Removed:** the rev. 1 design. A guard test (`tests/no-replaced-mechanisms.test.ts`) stops it
  coming back. ADR-0043 is amended.
- **Checks:**
  - `tsc` is clean. The full `bun test` gave 2246 pass, 0 fail. `liveness-wiring` "NEVER
    stall-aborted…" is a pre-existing flake (it fails 3/5 on plain `dev` under load).
  - Per-task reviews and the final review are clean after their fix rounds.
  - Security review: no findings in the diff.
  - Push scan: 0 critical. It found 2 new HIGH in transitive deps (body-parser 2.3.0, zod 4.4.3),
    the same on `dev` and master. Fixed with `overrides` in `package.json` (body-parser 2.4.0,
    zod 4.6.7). The re-scan has 0 high. The open mediums (fast-uri, hono, ip-address and 3
    semgrep lines) are in code or deps this branch did not change.

## Next steps (operator)
1. Merge `dev` → master and restart (permission needed). Ledger migration: v11 → v13, with
   automatic backups.
2. Install the tool skills: `bun tools/catalogue/install.ts` (it writes `~/.claude/skills`; no
   restart needed).
3. Read the `worker_env_report` key names, set `tools.workerEnv.inherit`, then
   `tools.workerEnv.engineSecrets: "strip"`, then restart.
4. Relay: before `tools.relayEnabled: true`, bound the reply body read and run `findSecret` on
   replies (deferred). Then ScaleDown → `active` (DPA + quota).
5. Decide on `origin/claude/project-thread-n3xiqw`: `c12c46f` is ported. Its other 4 commits are
   typed-answer routing, yes/no answering an Allow/Deny, Telegram line order and api-retry backoff.
6. Known limit (ADR-0050): workers run as root with Bash, so the engine boundary holds at the tool
   level only. A separate worker uid closes it.

---

# Earlier: waiting threads (ADR-0045) + project notes (ADR-0043)

## Goal
Finished threads must leave WAITING. An hourly loop re-checks WAITING threads and reminds the
operator once, only when the list changes.

## Done (on `dev`, restart-gated)
- **Root cause:** a decision closes only through its own card (tap or reply to the card). The
  operator answers elsewhere: a new message (a new thread), a re-ask under a new id, or chat that the
  worker acts on. Nothing closed the original question, so `deriveThreadState`
  (`src/engine/thread-state.ts:18`) kept the thread `waiting`. ADR-0038 (on dev since 10-15, not
  live) would settle only 1 of 20.
- **Fix (ADR-0045):** `src/engine/waiting-sweep.ts` + CLI `tools/threads/sweep.ts`:
  - A decision closes only on evidence the engine checks: a commit or tracked file newer than the
    question.
  - The worker is offered only the decisions whose repository moved.
  - One reminder is sent, only when the list changed.
  - Loops gained `report: "goal"`, and a command goal keeps its output.
  - `supersedeDecision` cancels the todos parked on the decision.
- **Loop:** `docs/loops/waiting-sweep.json`, cron `0 * * * *`. It is NOT loaded yet.
- **Cleanup, applied to the live ledger 2026-10-22:** `tools/oneoff/2026-10-22-close-done-waiting-threads.ts`.
  - Backup: `data/ledger.db.bak-2026-10-22-waiting-sweep-1792684504336`.
  - 14 decisions superseded. 9 threads went to done (m9g0b m74i2 ma18s mae06 m9ygk macay m9pfe
    m9piu m9yn1).
  - Todos #406 #413 #418 cancelled. The SOS plan was marked done.
  - The 14 asks that stay open were seeded as judgements.
  - WAITING threads: 21 → 12. Evidence: `docs/investigations/2026-10-22-waiting-threads.md`.
- Tests: 2010 pass. `tsc` clean. Security review: no findings. Code review: findings fixed.
- Earlier on dev: project notes (ADR-0043), test temp root (ADR-0042).

## Next steps (operator)
1. Merge `dev` → master, then restart neo.service, with the operator's permission. Never restart
   without it.
2. After the restart, run `bun tools/create-loop.ts docs/loops/waiting-sweep.json` (loads the hourly
   loop). Do not run it before: dev code would migrate the live ledger to v12 under the v11 daemon.
3. Rotate the sandbox password that the operator typed in plain text in thread m9ytv. It is stored
   in the ledger.

## Still waiting for the operator (10 + 1 unclear + 1 live approval)
m7hji, m7ijm, m9snq ×2, m9ytv ×2, ma71j, ma8ox (plan), m7wys, maby3, mab0w (2 plans), m8k9f.
Unclear: m7nk8. Live approval: maeue. The asks are in the investigation doc.

## Gotchas
- The sweep CLI writes the ledger from its own process and cannot see live sessions. The daemon
  corrects a thread on its next line.
- Commit messages: write them to a file and use `git commit -F`.
- A worktree needs a `node_modules` symlink. Remove the link before `git worktree remove`.
