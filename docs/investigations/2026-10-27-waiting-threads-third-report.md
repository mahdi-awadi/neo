# Waiting threads, third report (2026-10-27)

The operator raised this for the third time (2026-10-15, 2026-10-22, 2026-10-26). The console's
Threads tab, filter `waiting`, shows 10 eticket-v3 threads from 8 hours to 9 days old. Most show
"todos 0", and nothing moves them.

**Method.** All facts come from checks, not memory:
- a `VACUUM INTO` copy of `data/ledger.db` (schema v11), read with `bun:sqlite`;
- `git` on `/home/neo` (master `4452b94`, dev `e94e33e`);
- the dev code's own cleanup, run as a dry run on a copy;
- read-only evidence in each project repository (commits, plan files, `HANDOFF.md`).

Decision ids are the first 8 characters. Thread refs are as in the console (`m` + base-36 id).

## 1. The short answer

1. **None of the fixes run.** The daemon runs master `4452b94`. Every fix for this problem
   (ADR-0038, 0045, 0052, 0053) is on `dev` only, 84 commits ahead. The engine has booted 55
   times since 2026-10-13, every time on master.
2. **Even on dev, the fixes are not complete.** On today's data, dev settles 9 of the 22 stale
   decisions we checked by hand. It leaves 13 stale ones open, and it wrongly closes 1 real
   question.
3. **The process lets a fix sit undeployed.** "Done" means "committed on dev". The merge and the
   restart are one operator decision among 112 open decisions. The operator answered "Later" on
   2026-10-22, and nothing tracked it after that. The SDK updater then moved master and restarted
   the engine twice, still without dev.

## 2. The eticket-v3 threads in the screenshot

"Evidence" is from the project repository. "Dev" is what dev's `settle-decisions` dry run does with
the decision.

| Thread | Open decision | Real state (evidence) | Why it never closed | Dev |
|---|---|---|---|---|
| mbhoy | 4fc5a9c1 fix or remove the Refund button | **OPEN**: `dc649ce2b` "task 4 waits on the operator" | A real question, 1 day old | keeps (correct) |
| m7hji | ba954c7c where support sees the AI chat | **DONE**: `e96f684a4`, `dce39878d` (ADR-0183, 10-22) | The work answered it; nothing closes a card from work | keeps: its order has no outcome (G1) |
| mb10k | aa76e69d oldest-code plan card | **DONE**: phases 0–5 built by #603/#610 | Approved in chat; master has no chat path to a card | closes (correct) |
| mb10k | 4bb30cac offer-cache spec card | **DONE**: `36199c460`, `f64552479`, `bd4711932` | Same | closes (correct) |
| mb10k | 8d780b6d observability plan card | approved 10-25, phases 0–7.3 built, 7.4–10 left | Approved in chat; card never moved | keeps "awaits Approve" (G3) |
| mb10k | be78cb62 which plan to continue | **MOOT**: both plans went ahead | Nothing closes a moot question | keeps until it is 7 days old |
| mb10k | 99cbadfa (prod-ops) delete stale CityNet offers | **MOOT**: offers expired by 10-26 (`e11e069`) | Misfiled here (bug A); moot | keeps: the word "delete" (G2) |
| mb10k | todo #611 `waiting` on aa76e69d | plan built; #611 never ran | The card never closed | cancels #611 (correct) |
| mb1et | none open (d21c28fe dismissed) | observability spec, built | Thread state not re-derived after dismiss (bug B) | → done (correct) |
| mast7 | d83217cb start 3 follow-up defects | **OPEN**: no fix commit; WalletDetailPage still broken | A real question | **closes it wrongly** as "answered in chat" (G4) |
| magha | daa64d3a (gold) price-bot token | **OPEN**: needs a secret from the operator | Real; misfiled on an eticket thread (bug A) | keeps (correct) |
| magha | ae0daf27 (mirshad) WIO shared DB | **DONE**: mirshad `b32deccb` (10-23) | Done by work; misfiled (bug A) | keeps: the word "shared DB" (G2) |
| maex6 | 708b51b4 Stage C prod migrations | **OPEN**: prod, destructive | Real | keeps (correct) |
| maex6 | 2aa143d2 Asfoor prod Qi test top-up | **DONE**: `aa65cce57` (10-23) | Done by work | keeps: the word "prod" (G2) |
| maex6 | 544144fb CityNet segment spec card | **DONE** and released: PR #227 `8e41eaeb3` | Built without the card's button | keeps "awaits Approve" (G3) |
| ma8ox | none open (d3ed03e2 dismissed) | built, except T6 (the prod release) | Bug B. T6 is not tracked anywhere | → done; T6 stays untracked (G6) |
| ma71j | f5559e7d background-sync account | **DONE**: `7ca1ca229`…`582c36219` (10-22) | Done by work | expires (correct) |
| m9snq | 789a27fb payment_tokens | **DONE**: `d325fc3ef` (ADR-0181) | Done by work | expires (correct) |
| m9snq | 73c66293 charter-hotel RPCs | **DONE**: `d325fc3ef` | Done by work | expires (correct) |

Dev would move 5 of these 10 threads out of WAITING: mb1et, ma8ox, ma71j, m9snq and mast7 (mast7
only by the wrong close). mbhoy, m7hji, mb10k, magha and maex6 stay WAITING.

**Live duplicate work:** todo #700 (running now) rebuilds the oldest-code plan that #603/#610
already built. #611 waits on the open card, so the operator dispatched #700 by hand. #700 has an
uncommitted edit to the plan file.

## 3. contantme, adminli and the other projects

These are the decisions the other waiting threads hold, checked the same way.

| Decision | Thread | Real state | Dev |
|---|---|---|---|
| bf799a94 CityNet prod fix | mbh5v (contantme, misfiled) | **OPEN**: prod release needed | keeps (correct) |
| 666f1438 contantme cards plan | mbhgg | **MOOT**: file says `status: superseded` by the master plan | closes (correct) |
| 9f6a2b95 / eeb030d9 adminli IG fixes plan + spec | maq81 (mirshad, misfiled) | **DONE**: `b66550f`…`1f43ee5` | closes the plan; keeps the spec "awaits Approve" (G3) |
| 94a0c900 / f7966fb7 Redis rotation | maq81 (misfiled) | **MOOT**: dropped by the operator (`a68716b53`) | keeps (G2, G3) |
| 51071d74 dev secret rotation plan | maq81 (misfiled) | **DONE** on dev (`86071b683`) | keeps "awaits Approve" (G3) |
| cc66eb96 traefik router hosts | maq81 (misfiled) | **DONE**: containers recreated 10-23 08:21 | keeps until it is 7 days old |
| 3d2efae1 waselni hotfix or wait | mbgjp | **DONE**: hotfix live (`43b5715b`) | closes (correct) |
| 469c565d waselni detail-screen spec | mbjrt | **DONE**: `c67c5b4f`, committed 1 minute before the card | keeps "awaits Approve" (G3) |
| da926828 gold price source | m8k9f | **MOOT**: replaced by daa64d3a | closes (correct) |
| 12a2836a delete 4 DNS records | mb3zd | **OPEN**: live DNS | keeps (correct) |
| f0282349 airlines SQL on prod | mb5lr | **OPEN**: prod SQL | keeps (correct) |
| 1f7d20a3 Asfoor sandbox admin | maby3 | **DONE**: prod-ops `821dbaf` (10-22) | keeps: the word "admin access" (G2) |

## 4. Causes, counted

We checked 30 open decisions on waiting threads, and 2 threads that are waiting with no open
decision.

| Cause | Count | Example |
|---|---|---|
| C1. The work is done in the repo, but the card never closed | 16 | ba954c7c, f5559e7d, 544144fb |
| C2. Made moot by later events | 6 | 99cbadfa, 94a0c900, 666f1438 |
| C3. Approved in chat; the build is in progress; the card never moved | 1 | 8d780b6d |
| C4. Really waits on the operator (5 of the 7 are prod or a secret) | 7 | 4fc5a9c1, d83217cb, 708b51b4 |
| B. The thread state was not re-derived after a decision closed | 2 threads | mb1et, ma8ox |
| A. Another project's decision on the thread | 10 decisions on 4 threads | magha, maq81, mbh5v, mb10k |

Of the 10 in row A, 6 are on maq81 ("Do all todos"), a fan-out order that ADR-0016 lets hold many
projects. The other 4 (magha 2, mbh5v 1, mb10k 1) are misfiled (bug A). In both cases the console
lists the thread under the thread's project, so a gold question shows as eticket-v3 waiting.

So 23 of the 30 (77%) are not waiting on anything. The engine has no path from "the work happened"
to "the card closes".

Across the whole ledger: 25 threads are `waiting` and 112 decisions are `open`. 75 of the 112 have
no thread (they are older than the trace spine). We did not check those one by one.

## 5. Every earlier attempt

| Fix | Commit, date | What it does | On master? | Would it fix today's cases? (dev code run on a copy) |
|---|---|---|---|---|
| ADR-0036 big plans wait; the card follows the plan | `51e0fd9` 10-13 | A card closes when its plan is done or dropped | **yes** (the last code merge) | It is live. It does not see a plan built under another todo, or approved in chat |
| ADR-0038 a thread waits only on a live question | `1b4f5f9` 10-15 | supersede: asked again, answered in chat, plan settled; operator Close | no | small part: 1 of 20 threads on 10-22; on today's data its "answered in chat" rule closes d83217cb wrongly |
| ADR-0045 waiting sweep + hourly loop + one-off | `023daad`…`92f3d74` 10-22 | an AI worker closes a decision on checked commit or file evidence; one reminder per change | no (the one-off ran on the live ledger 10-22) | the evidence-close is the right tool for C1, but the loop was never loaded (it is restart-gated) and it does not close plan cards |
| ADR-0052 a held session takes no brief | `58ad282` 10-26 | todos wait instead of "delivered" into a held session | no | not this symptom (it prevents fake "done" todos) |
| ADR-0053 thread on its work; a close re-derives; expiry; `plan` tool; cleanup | `09a1d1d`…`e94e33e` 10-26 | fixes bugs A and B for new work; expiry after 7 days; chat Approve/Drop | no | 9 of 22 stale decisions close, 13 stay (G1–G3), 1 real question closes wrongly (G4); the 4 misfiled decisions stay misfiled (G5) |

**Trial merge (checked 2026-10-27).** `git merge-tree master dev` has no conflicts. The only
master-only commits are the two SDK pins. On the merged tree, `tsc` is clean. The `bun test` result
is in section 7.

## 6. Root cause

### Why each fix "did not work"

1. **Never deployed (all four).** Each fix was built, tested and committed to `dev`. Each was then
   marked "restart-gated" and handed to the operator. None of them was merged.
2. **Incomplete even on dev.** The fixes judge a decision by the **shape of the ledger**: ages,
   order outcomes, plan status and key words. The real evidence is in the **project repo**. Gaps:
   - **G1. Orders without an end.** 973 of 2,717 orders have no outcome row. An order ends without
     one when the engine restarts, when it is delivered into a live session, or when it is queued as
     a todo. All 46 open decisions on such orders had no activity after a later engine boot, so
     they are dead. Dev's expiry rule needs "its order ended", so these never expire.
   - **G2. Key words keep done work open.** The keep list (prod, delete, admin, refund…) is matched
     on the question only, never on whether the action happened. 2aa143d2, 1f7d20a3, ae0daf27 and
     99cbadfa are done or moot. They stay open for ever with no next step.
   - **G3. A plan card follows only the ledger's plan row.** A plan built by other work, released
     by a hotfix, approved in chat before the `plan` tool existed, or committed before its card was
     sent (469c565d) stays "awaits Approve & build".
   - **G4. "Answered in chat" guesses.** It treats any operator line in the thread, followed by any
     finished work in the folder, as the answer. d83217cb shows it hides a real question.
   - **G5. Waiting is counted per thread, not per project.** ADR-0053 files new work on the right
     thread. It does not move the 4 misfiled decisions, and a fan-out thread still shows under one
     project. So an eticket thread stays WAITING on gold's and mirshad's questions.
   - **G6. Nothing owns what is left over.** A dismissed card's last step (ma8ox T6, the prod
     release) and a kept question have no owner, no next action and no escalation. The Queue view
     shows todos only and the Threads view shows decisions only, so no view lists "what is waiting
     on whom".

### Why a fix sat on dev, unnoticed, three times

- **"Done" stops at dev.** The rule "always commit completed work to dev" and every handoff end with
  "restart-gated, operator step". No step owns the merge to master, and nothing measures whether a
  fix is live.
- **The deploy question is one card among 112.** "Merge dev → master and restart?" (e123218d,
  10-22) was answered "Later, I'll restart". The restart decision 6fe20eba (10-26) is still open. A
  "later" answer creates no follow-up.
- **The SDK updater keeps master moving without dev.** ADR-0009 fast-forwards SDK pins into local
  `master` and asks for a restart (`2ff14ed` 10-23, `4452b94` 10-24). Each restart looked like
  progress but brought up master again: 3 boots after 10-22, all on master.
- **The engine knows, but says nothing.** `engine_boots` records `head_sha` and `branch` at every
  boot. Nothing compares them with `dev`.

## 7. Trial merge test result (2026-10-27)

We built the merged tree `git merge-tree --write-tree master dev` as a commit object with no
branch (`f9f212c`), and checked it out in a temporary worktree.
- `bunx tsc --noEmit`: clean.
- `bun test`: 2,278 pass and 2 fail out of 2,280. The 2 failures are timing tests under load:
  "dashboardSnapshot carries the derived state…" (7.2 s) and "a silent sub-run is aborted by the
  STALL limit…". Run again alone, `tests/dispatch.test.ts` and `tests/dashboard.test.ts` give 112
  pass and 0 fail.
- Schema: the live ledger is v11 and the merged code migrates it to v13 at the first boot (v12
  project notes, v13 note questions). The migration adds tables and columns only.

## 8. What needs the operator now

- **Approve the plan:** `docs/superpowers/plans/2026-10-27-waiting-work-ship-and-settle.md`.
- **Todo #700** is rebuilding a plan that is already built (see section 2). Stop it or let it
  finish. The engine does not decide this.
- **7 real questions:** 4fc5a9c1, d83217cb, 708b51b4, daa64d3a, bf799a94, 12a2836a, f0282349.

## 9. The guard that existed, and why it was silent

The restart producer (`src/engine/producers/restart.ts`, on master since 2026-10-06, ADR-0018)
already lists work that is built but not running. It reports local branches whose names start with
`restart.branchPrefixes`, which defaults to `fix/`, `feat/` and `chore/`. **`dev` does not match**,
so the 84 dev commits were never reported. What it did report on 2026-10-27 was 11 open attention
items, 5 of them old SDK pin branches (`chore/agent-sdk-0.3.295` … `0.3.308`) that later pins
replaced. That is noise, not a signal.
