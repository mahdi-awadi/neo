---
approval: required
---
# Self-explaining attention items and todos — plan

Spec: `docs/superpowers/specs/2026-10-29-self-explaining-attention-and-todos-design.md` (ADR-0059).
Branch `feat/self-explaining-attention` from `dev`, worktree in `/tmp`. TDD per task; `bunx tsc --noEmit`
and `bun test` green before each commit. Built on dev only: no merge, no restart.

Why approval: a ledger migration (v14 → v15, two additive nullable columns) and a new AI call per todo.

- [x] 1. **Migration v15** — `attention_items.facts TEXT`, `project_todos.summary TEXT`; `AttentionDraft.facts`,
   `NewTodo.summary`/`TodoRow.summary` through insert/upsert/map. Test: v14 ledger migrates, old rows read.
- [x] 2. **Producers write facts** — github (pr/issue number, PR title, draft, Dependabot name/from/to, workflow,
   branch, alert severity), git (branch, days, base, ahead, upstream, path), engine (thread title, age,
   label), skillify, restart. Tests per producer.
- [x] 3. **Brief templates for every kind** — add the GitHub and git kinds to `ATTENTION_BRIEFS` with `{fact}`
   fill; export `GITHUB_KINDS`/`GIT_KINDS`; the coverage test includes them. → todo works for all.
- [x] 4. **`attention-explain.ts`** — badge, plain title (prefix strip, `(x)(x)` collapse, Dependabot bump parse),
   facts (stored, else derived from kind/key/url/title), links, brief. Tests: the three live examples, a
   row with no facts, an unknown kind.
- [x] 5. **View + console** — `AttentionItemView` gains badge/plain/facts/links/brief/project; the console renders
   badge, project, plain title, `att.why.*`, links, `att.next.*`, the full-brief disclosure; `att.*` keys in
   EN + AR (key-parity test). `/attention` in Telegram shows `[badge] plain title`.
- [x] 6. **Todo summary** — `summarizeBrief` (deterministic) + `todo-summary.ts` (AI upgrade on worker path
   `summary`, zero tools, enforced: one line, 8–90 chars, no secret, else fallback; `todoSummary.ai`
   config); written on add; carried on continuation/retry/side re-add; `todoTitle(t)` reads it. Queue tab +
   dashboard show it, tap opens the brief. Tests for each acceptance criterion.
- [x] 7. **Docs** — ADR-0059, CONTEXT.md (plain title, badge, todo summary), CONFIG.md, HISTORY.md, HANDOFF.md.
- [x] 8. **Verify** — full suite; console screenshots EN + AR of the Projects attention list and the Queue tab
   (before/after) against a dev copy of the ledger, copied to `/home/neo/agent`; `/security-review`;
   independent code review; fix findings; commit on dev.
