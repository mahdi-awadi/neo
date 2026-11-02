# Waiting sweep — design (ADR-0045)

## Seam

`src/engine/waiting-sweep.ts`: one module, pure where it can be. Two seams: the ledger and git
(`GitRunner` from `git-read.ts`).

```ts
interface SweepDeps { ledger: Ledger; refresh: (threadId: number) => void; git: GitRunner; now: () => number; cfg: WaitingSweepCfg }
waitingDecisions(deps): WaitingDecision[]            // open decisions of WAITING threads, with repo + latest commit time
needsJudging(d: WaitingDecision, judged: Judged, cfg, now): boolean
closeWithEvidence(deps, id8: string, ev: { commit?: string; file?: string }, reason: string): { ok: true; thread: string; todosCancelled: number[] } | { ok: false; why: string }
keepJudged(deps, id8: string, ask: string): { ok: boolean; why?: string }
reminder(pending: WaitingDecision[], judged: Judged, cfg): { text: string; fingerprint: string }   // "" when empty
check(deps): { met: boolean; out: string }           // the loop goal: refresh, gate, reminder-on-change
```

`tools/threads/sweep.ts` is a thin CLI over it: `check | list | close | keep`. `check` exits 0 when
`met` and prints `out`.

## Rules

- **Repository of a decision:** `git rev-parse --show-toplevel` in its folder. A missing worktree
  folder falls back to the part of the path before `/.worktrees/`. The company folder
  (`companyFolder`) is a repository like any other. No repository → it cannot be judged with
  evidence. It stays in the reminder.
- **Latest commit time:** `git log --all -1 --format=%ct`.
- **Needs judging:** there is no judgement yet, OR (the latest commit time > the judged commit
  time AND now − judgedAt ≥ `rejudgeAfterMs`). Plan cards never need judging (they follow the plan);
  they are listed in the reminder.
- **Verified close:**
  - The id (8+ characters) must match exactly one open decision in a WAITING thread, and not a plan card.
  - `--commit`: `hasCommit` is true and the commit time is greater than `decision.createdAt`.
  - `--file`: the path is relative, has no `..`, and has no wildcard or pathspec magic (`*?[]:\`); git
    reads it with `--literal-pathspecs`. It is tracked (`git ls-files --error-unmatch`),
    and its last commit time is greater than `createdAt`.
  - `reason` is ≥ 10 chars and ≤ 300.
  - Then `ledger.supersedeDecision(id, "done by later work: <reason> (<evidence>)", at)`. This now
    also cancels the todos parked on the decision, and returns their ids. Then refresh the thread.
- **Offer:** `check` marks each decision it hands the worker as judged now (`offeredAt`), keeping any
  earlier ask, so a worker that judges nothing does not block the reminder or get paid for again
  before `rejudgeAfterMs`. Judgements of decisions that left the list are dropped.
- **Keep:** it stores `{ at: now, commitAt: latest, ask }` under meta `waitingSweep.judged`
  (a map by decision id). The ask is ≤ 160 chars.
- **Reminder:** one line per WAITING thread (newest first): `• <ref> <project> — <ask or question,
  ≤ 120 chars>`, plus ` (+N more)` when the thread has several open decisions. Header:
  `⏳ Waiting on you (<n>):`. At most `reminderMaxLines` lines, then `…and K more`. Fingerprint:
  sha256 of the sorted `threadId:decisionId:ask`. Sent (= printed by `check`) only when it is not
  empty and differs from meta `waitingSweep.reminder`. The meta key is then updated. An empty list
  resets the key, so a later list is sent again.
- **Loop field `report: "goal"`** (`LoopInput`, `LoopDef`, validation): in `startScheduledLoop`,
  worker text is recorded in the loop thread but not sent. After the run, the goal's whole output
  (`out.lastOutput`, a command goal's stdout) is sent once, only when the goal was met and the output
  is not empty. A manual `/loop` run sends it too. The default (`"worker"`) keeps today's behaviour.

## Config (`waitingSweep`)

| Key | Default |
|---|---|
| `rejudgeAfterMs` | `21600000` (6 h) |
| `reminderMaxLines` | `15` |

## Acceptance criteria

1. `check` with no WAITING thread → met, empty output. With WAITING threads all judged and no newer
   commit → met, and the reminder printed once. A second `check` → met, empty output (no change).
2. A decision with a newer commit, judged more than 6 h ago → `check` not met.
3. `close` refuses: an unknown or ambiguous id8; a plan card; a commit that does not exist; a commit
   older than the question; an untracked file or a `..` path; a reason that is too short. Each
   refusal names the rule. A good close → the decision is `superseded` with the reason, the parked
   todo is `cancelled`, and the thread is re-derived (`done` when nothing else is open).
4. `report: "goal"` → worker text is not sent; one message with the goal detail is sent; an empty
   detail sends nothing. Without the field, behaviour is unchanged (an existing test stays green).
5. The `waiting-sweep.json` loop passes `validateLoopInput`: cron `0 * * * *`,
   `goalCommand: bun tools/threads/sweep.ts check`, `report: "goal"`, `freshSession: true`.
6. The one-off: the dry run lists the 14 decisions; `--apply` takes a backup, supersedes only rows
   still `open`, cancels parked todos #406 #413 #418 if they are still `waiting`, marks the SOS plan
   `done`, re-derives the 9 threads to `done`, and seeds `waitingSweep.judged` for the 14 that stay.
   A second run changes nothing.

## Edge cases

- A decision folder that is not a git repository → it is never judged, but it is listed.
- git fails or times out → the decision counts as not changed (it fails quiet), and it is listed.
- A thread with a session still running: the daemon re-derives it on its next line (ADR-0045
  consequences).
