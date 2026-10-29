# Attention items and todos explain themselves

**Status:** accepted (2026-10-29; built on dev, restart-gated). Related: ADR-0018 (attention items),
ADR-0008 (todo queue), ADR-0005 (pinned models), ADR-0047 (limit-wait display).

## Context

In the console's Projects tab an attention item read "#360 PR #31: chore(deps)(deps): bump …" or "#321
feat/multi-project-ui: no commit for 26 days, not merged into main": no kind, no project, no reason, and no word
on what "→ todo" does. "→ todo" did nothing for every GitHub kind and every git kind but `dirty`: there was no
brief template, so the tap answered "no brief template". Todos were named by the first 60 characters of their
brief, often engine text ("Continue this task in a fresh session…").

## Decision

1. **Facts, not prose, from the producers.** An item carries structured facts (`attention_items.facts`, JSON,
   ledger v15), written by its producer and refreshed on every scan. An older or one-shot row gets its facts
   derived from its kind, key and title (`attention-facts.ts`; the engine wrote those titles).
2. **One explain step.** `explainAttention(row)` gives a badge (`dep_update_pr` for a Dependabot PR), a plain
   title (`(x)(x)` collapsed, conventional prefixes dropped, "bump X from A to B" read as "X A → B"), the facts,
   the links and the exact brief → todo sends. It writes no prose: the console renders the badge, the reason and
   the next step from `att.*` catalogue keys (EN + AR) filled with the facts, each value escaped and isolated
   LTR. Telegram (English) shows `[badge] plain title`, the badge name read from the same EN catalogue.
3. **A brief for every kind.** The GitHub and git kinds got templates filled from the facts; the coverage test
   covers every kind list, so a new kind without a brief fails `bun test`. A kind with no brief shows no → todo.
4. **A todo summary.** `project_todos.summary` (v15): the deterministic `summarizeBrief` at once (a continuation
   shows its original task, a plan step names its plan, order labels and markdown go), carried by
   continuations and re-adds. A model may propose a better line (config `todoSummary`, default the haiku tier at
   low effort); the engine keeps it only if it is one plain line of 8–90 characters with no secret shape. The
   run has no tools, no settings and no MCP servers (`settingSources: []`), one turn. Every surface names a todo
   by `todoLabel` (summary, else derived); the Queue tab opens the brief on tap.

## Alternatives rejected

- **Parse the stored titles in the console.** The titles are English engine text; parsing them in the client
  ties the UI to producer wording and cannot translate.
- **Translate the producers' titles.** A second translation mechanism in the engine; the catalogues are the one.
- **A summary only from the model.** A failed or slow run would leave a todo unnamed; the deterministic line is
  there at once and stays when the model's line is rejected.
- **Backfill old rows with a migration job.** Scan-driven items refresh their facts within one scan; the rest
  derive what they need when read. No job, no lock.

## Consequences

- The adminli Dependabot config doubles its scope; adminli was told (note #470). The console collapses it.
- Each new todo costs one short haiku turn (config `todoSummary.ai: false` turns it off).
- Restart-gated: the migration runs, and producers start writing facts, on the next boot.
