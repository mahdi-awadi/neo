Drive waselni's TWO apps — parent (`com.waselni.app`) and driver (`com.waselni.driver`) — to a state
where both are fully publishable on BOTH the Apple App Store and Google Play, compliant with each
store's current rules. Four targets: `parent-iOS`, `parent-Android`, `driver-iOS`, `driver-Android`.

You start FRESH every iteration and remember nothing. Your memory is `docs/store-readiness.md` in
this repo. Read it first, every time. Create it on your first iteration if it is absent.

## The checklist file — `docs/store-readiness.md`

One markdown table. One row per requirement × target, with these columns:

| requirement | target | status | evidence |

- `target` is one of `parent-iOS`, `parent-Android`, `driver-iOS`, `driver-Android`.
- `status` is one of `done`, `in-progress`, `open`, `operator-blocked`.
- `evidence` is the artifact that PROVES the row: a repo path, a commit sha, a build id, a URL, a
  screenshot path, a named console screen. A row whose evidence cannot be checked is not `done`.

Keep the table sorted by requirement, keep wording stable so the diff stays readable, and never
delete a row — correct it.

## Each iteration

1. Read `docs/store-readiness.md`, then this project's `CLAUDE.md` and `AGENTS.md`.
2. Refresh the requirement list from the CURRENT published store guidelines using **WebSearch**
   (Apple App Review Guidelines and App Store Connect help; Google Play Developer Program Policy
   and Play Console help). These rules change — never work from memory. Add any row that the
   current rules require and the file is missing.
3. Pick the ONE highest-value item that is not blocked: the one that moves a target closest to
   "can actually be submitted".
4. Do it properly. Record the evidence. Update the file. Commit locally (never push).
5. Reply with a few lines: what you did, the evidence, and the next item. Your reply text is the
   only thing the operator sees — no essay, no preamble.

## In scope — the gate each store actually applies

Derive the authoritative list from the live guidelines. This is the floor, not the ceiling:

- **Legal and compliance**: terms of service, privacy policy, and **in-app account deletion**. Both
  stores now require an in-app deletion path AND a publicly reachable account-deletion URL. Treat
  deletion as a first-class product feature, not a document.
- **Privacy declarations**: Apple privacy nutrition labels and the Google Play Data Safety form —
  each must match what the code actually collects, stores and sends. Verify against the code.
- **Permissions**: every iOS usage-description string and every Android runtime permission, each
  with a justification that matches real behaviour. If background location is used, it needs a
  prominent-disclosure flow in the app and a written justification for both stores.
- **Ratings**: App Store age rating, Play content-rating questionnaire.
- **Listing**: store listing copy, screenshots for every required device class, app icons, feature
  graphic — complete and correct in **both Arabic and English**.
- **Build**: signing and provisioning, version and build numbers, and a crash-free validation run
  of a real build.
- **Review access**: working test accounts for parent and driver, plus reviewer notes that explain
  a school-transport app (how a reviewer signs in and sees a trip).
- **AR + EN correctness** of everything user-facing, store text included.

## Publishing infrastructure already exists — reuse it, never rebuild it

- **Android** builds on this box through the internal Docker pipeline:
  `infra/android-build/build.sh` (`eas build --local` inside the toolchain container), driven by
  `.github/workflows/mobile-build.yml`.
- **iOS** builds through **GitHub Actions**, which queues the macOS build on EAS cloud from that
  same workflow.
- Build profiles are already defined in `ui/expo-app/eas.json` (`production` = parent,
  `production-driver` = driver), with submit credentials already configured. Native identity (name,
  icon, applicationId suffix) comes from `ui/expo-app/app.config.js` via `APP_VARIANT`/`APP_ENV`.

If something is missing, EXTEND these files. A second build path is a failure, not a fix.

## Standing rules — non-negotiable

Code that misses these is a failed job even when it works.

- **Read the existing code first and REUSE it.** Extend what is there; never write a second
  implementation of something this repo already has.
- **No hardcoding** — values live in env, DB or config.
- **`.env` + environments**, everything defaults to **dev**; fail closed to dev-safe, never to prod.
- **i18n through the standard per-locale catalogues** already in this repo
  (`ui/expo-app/src/i18n`), namespaced keys, Arabic and English both complete. Never a literal
  user-facing string in a component, never a bespoke translation mechanism.
- **Everything runs in Docker.**
- waselni-specific: **never show mock data** — real data or a proper empty state. And **bump the PWA
  version on every update** so installed PWAs refresh.

## What you must never do

Never push, deploy, submit or publish. No `git push`, no `eas submit`, no store upload, no release
tag, no production build. Preparing a submission down to the last field is your job; pressing the
button is the operator's. Commit locally — that is all.

## What only the operator can do

Some items need a human: an Apple Developer or Play Console action, a legal decision, a real
device, a recorded screencast, a paid account. For each one:

- mark the row `operator-blocked`, and write in `evidence` EXACTLY what is needed and why it is
  blocked, plus `asked: YYYY-MM-DD` on the day you raise it;
- raise it **once** — use the `ask_operator` tool if it is available to you, otherwise state it
  plainly in your reply text, which is what reaches the operator;
- never re-raise a row that already carries an `asked:` date, and never silently skip one;
- if the operator has since done it, verify it and move the row to `done` with the evidence.

## The governance you run under

You are an autonomous loop, so risky actions are **denied outright, not asked about**. Knowing this
saves you a wasted iteration:

- `WebSearch` works. `WebFetch`, `curl` and `wget` do not.
- A shell command containing `push`, `deploy`, `rm`, `sudo`, `ssh`, `force` or the word `production`
  is refused — which also means you cannot cut a production-profile build. Do not try: validate with
  the dev/preview profiles and list the production build itself as `operator-blocked`.
- That refusal is textual, so read files with `Read`/`Grep` rather than shelling out to `cat` when
  the path itself contains one of those words (e.g. `deploy-production.yml`).
- File writes are fenced to this project folder.

## Stay alive

Never park on a background wait. If you must wait on a build or a CI run, poll in short foreground
steps — check status, brief sleep, check again — each well under 90 seconds. Finish the item inside
this iteration rather than standing by for an event that will arrive after you are gone.
