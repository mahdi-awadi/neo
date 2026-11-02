# Self-explaining attention items and todos — design (ADR-0059)

Operator order 2026-10-29 (console UX). In the console's Projects tab the attention items read
"#360 PR #31: chore(deps)(deps): bump expo-localization …" or "#321 feat/multi-project-ui: no commit for
26 days, not merged into main". The operator cannot tell what an item is, why it is there, or what
"→ todo" makes a worker do. Todos read as the first 60 characters of their brief, often engine text
("Continue this task in a fresh session…").

## Findings (checked in the code and the live ledger, read-only)

1. An item carries only an English `title` the producer wrote. The view already sends `kind`, `source`,
   `detail`, `url`, but the console shows only the title.
2. **"→ todo" does nothing for most kinds.** `toTodo` refuses a kind with no brief template, and only the
   engine, dirty, note, skillify and restart kinds have one. Every GitHub kind (`pr_open`, `issue_open`,
   `ci_failed`, `dependabot`, `code_scanning`, `secret_scanning`, `pr_review_requested`) and every git kind
   except `dirty` (`stale_branch`, `unpushed`, `no_upstream`, `drift`, `worktree`) answers "no brief
   template for <kind>". Live: 13 open `pr_open`, 8 `stale_branch`, 8 `unpushed`, 6 `issue_open` items.
3. `(deps)(deps)` is in the real PR title: adminli's `dependabot.yml` has prefix `chore(deps)` plus
   `include: scope`. Sent to adminli as note #470. The console collapses the duplicate for display.
4. One function, `todoTitle(brief)`, names a todo on every surface (Queue tab, `/todo`, dispatch replies,
   the dashboard, trace). It is the seam for the summary.

## The seam

`src/engine/attention-explain.ts`: `explainAttention(row) → AttentionExplain`, deterministic, no I/O.

```ts
interface AttentionExplain {
  badge: string;          // a catalogue key suffix: "stale_branch", "dep_update_pr", "pr_open", "thread_waiting", …
  title: string;          // a plain one line, no "PR #31:" / "thread waiting 2d:" prefixes, "(x)(x)" collapsed
  facts: Record<string, string | number>;   // what the description template needs: branch, days, base, pr, from, to, …
  links: Array<{ kind: "pr" | "issue" | "url" | "branch" | "thread"; label: string; href?: string }>;
  brief?: string;         // exactly what → todo would send (attentionBrief), or undefined when → todo is refused
}
```

- **Facts are written by the producer** into a new `facts` JSON column on `attention_items`; the upsert
  refreshes them on every scan, so scan-driven rows backfill themselves within one scan after the restart.
  A row without stored facts (old one-shot rows) gets facts **derived** from `kind`, `key`, `url`, `title`
  by one per-kind parser in the same module; when that also fails, the item shows its old title and the
  generic badge. Never an empty card.
- **Every produced kind gets a brief template** (`ATTENTION_BRIEFS`), filled with `{title}` and `{fact}`
  placeholders. The coverage test extends to the GitHub and git kind lists, so a new kind without a brief
  fails `bun test`.

The view (`AttentionItemView`) adds `badge`, `plain` (the clean title), `facts`, `links`, `brief`, and the
project name. The console renders, per item:

1. a badge chip `att.kind.<badge>` and the project name (LTR isolate for repo/branch names);
2. the plain title (`dir="auto"`);
3. a description `att.why.<badge>` filled from `facts` (i18next interpolation), plus links;
4. a line `att.next.<badge>` — what → todo will do — and a "full brief" disclosure with the exact brief;
   when → todo is refused there is no button and the line says why.

All new strings live in `locales/{en,ar}/console.json` under `att.*`; numbers and ids stay LTR.

## Todo summary

- `project_todos.summary` (new, nullable). Written when the todo is created: `summarizeBrief(brief)`, a
  deterministic line (strips the continuation head and `Original brief:`, the consult and dispatch-result
  wrappers, markdown, a leading "Operator order (date):"; first sentence; ≤ 80 chars).
- **AI upgrade, code enforces** (operator 2026-10-28): after the insert, a zero-tool, one-turn run on a new
  worker path `summary` (config `workers.summary`, model/effort configurable) asks for one plain line in the
  brief's language. The engine accepts it only if it is one line, 8–90 chars, has no secret shape, and is
  not empty; otherwise the deterministic line stays. Off with `todoSummary.ai: false`; on by default.
  Never on a customer path (todos never come from one), and the run has no tools.
- Continuations, retries and side-lane re-adds **carry the summary** of the todo they continue.
- `todoTitle(t)` everywhere reads `t.summary ?? summarizeBrief(t.brief)`; old rows derive it, so no backfill
  job is needed. The Queue tab and the project dashboard show the summary; a tap opens the full brief
  (`GET` carries it, capped).

## Acceptance criteria

1. Each of the live examples renders with a badge, the project, a plain title, a reason and a next-action
   line, in EN and AR: `#386` → Waiting thread · "Complete waselni project" · "waiting 2 days for an
   answer"; `#360` → Dependency update PR · "expo-localization 57.0.1 → 58.0.5" · PR link; `#321` →
   Stale branch · `feat/multi-project-ui` · "no commit for 26 days, not merged into main".
2. "→ todo" works for every kind a producer raises (no "no brief template"), and the test fails for a kind
   without one.
3. A row with no stored facts still renders a badge and title (derived or fallback); never throws.
4. A new todo's summary is the deterministic line at once; an accepted AI line replaces it; a bad AI line
   (multi-line, too long, secret-shaped, error, timeout) leaves the deterministic line.
5. `/todo`, the queue lines in dispatch replies and the Queue tab show the summary; a continuation shows the
   original task's summary, not "Continue this task…".
6. The ledger migrates v14 → v15 additively; old rows work unchanged.
7. AR and EN catalogues have the same keys; RTL screenshots show numbers and ids LTR.

## Edge cases

- A PR title that is not a Dependabot bump keeps its text, minus a conventional prefix (`chore(x):`).
- An Arabic brief: the deterministic summary keeps it; the AI line is asked in the brief's language.
- A huge brief: only the first 4000 chars go to the AI run; the summary is cut to 80.
- A note item: badge from its note kind (finding/request/fyi/question), title = the note title.
- AI summary run fails or the budget guard refuses it: the deterministic line, logged as an event.

## Not in scope

Translating producer titles for Telegram (Telegram stays English, now with the plain title and badge
name); changing what producers detect.
