# Spec: a pin's Open lands where it can be acted on; a plan can be read before it is approved

Date: 2026-10-30. ADR: 0071. Related: ADR-0065 (needs you, pins), ADR-0046 (md files), ADR-0025 (safe
Markdown), ADR-0049 (decision cards), ADR-0036 (plan approval).

## Problem (root causes, checked in the code)

1. **Open is a dead end.** `pinAction` (console `app.ts`) opens a todo, else a thread, else the
   PROJECT PAGE. An attention item (kind "Item") has no thread or todo, so it lands on the project
   page, which neither shows the question nor offers an answer. The live case: a `decision_stale`
   item ("decision open 24h: Should I write a plan…"), whose key is the open decision's id. The
   needs-you list never links that item to its decision.
2. **The console cannot answer a decision at all.** `answerDecision` (`reply-routing.ts`) is wired to
   Telegram's answer gestures and to plan approval, but no console route calls it. The thread view lists
   a decision read-only. A message typed in the thread reaches the project but leaves the decision open,
   so the pin never goes away.
3. **A plan cannot be read before it is approved.** The strip's plan button approves in one tap.
   `/md-file` (ADR-0046) only offers the file as a download, and the plan card gives no link to it.

## The seam

One engine module, `src/engine/needs-you-detail.ts`:

- `itemDetail(deps, ref, now)` returns the item a pin names, with everything needed to act on it, or
  `undefined`:
  - `dec:<id>`, a decision: `{ type: "decision", id, kind: "decision"|"alert", status, project,
    question, options?, spec?, threadId?, createdAt, answerable }`.
  - `dec:<id>`, a plan card: `{ type: "plan", decisionId, plan: { id, version, title, project,
    state, actions, path, file } }`, where `file` is the absolute path `join(folder, path)`.
  - `att:<id>`: `{ type: "attention", id, kind, project, title, plain, next?, url?, actions,
    decision?: <the linked decision's detail, when its key names an open decision> }`.
  - `todo:<id>` is not handled here: the console already has the todo sheet.
- `needsYou` items gain `decisionId` (a decision or plan card, and a `decision_stale` item whose
  decision is still open). The strip's button is **Open** for every kind except a failed todo (Retry
  stays one tap). Plan pins say **Review**: approving never happens without the plan on screen.

Routes (console session required, like every `/api/*` route):

- `GET /api/item?ref=<ref>` → `itemDetail`. 400 for a bad ref, 404 for a missing item.
- `POST /api/decision/answer { id, answer? | picks? | acknowledge? }` → web channel `answerDecision`. It
  reuses `reply-routing.answerDecision` and resumes through `handleMessage`, exactly as the Telegram
  answer does. It refuses, through `textAnswerRefusal` (shared with the company's `decision` tool): an
  unknown or closed decision, a governor approval (Allow/Deny on its card only), and a plan card (use the
  plan action). It also refuses an empty answer or one longer than `TELEGRAM_MAX`. `picks` (a structured
  card) must answer every question within range, and is joined by `answerText`. `acknowledge: true`
  dismisses an alert.
- Every non-GET request whose `Sec-Fetch-Site` is not `same-origin` is refused (403, CSRF).
- `GET /md-file?path=…&view=html` → the same `resolveMdFile` checks and the same audit event, plus
  `view: true`. It returns `{ name, html }` as JSON, where `html = mdToHtml(text, { target: "web" })`,
  the console's one safe renderer. No other viewer and no other file-read path.

## The console

The item sheet reuses the existing `<dialog class="sheet" id="tdsheet">`: one modal and one close
path, like the todo detail.

- **Decision:** the full question, `decisionCardHtml(spec)` (reused), one button per option (the
  answer is the option label), and a reply box (`textarea`, compose box `data-compose="send"`) with Send.
  It also has Open thread. An alert shows Acknowledge.
- **Plan:** the title and state, the plan rendered (fetched from `/md-file?view=html`), **Download
  .md** (`mdFileHref`, the same link the feed uses), **Approve & build**, **Drop** (with a confirm)
  and the "changes" hint.
- **Attention:** the title, its plain why and next step, its own action buttons (`→ todo`, snooze,
  dismiss: the existing `/api/attention` route), and the linked decision's answer block when there is one.
- **Mobile typing:** the sheet keeps its body above the on-screen keyboard. Its max height follows
  `--app-h` (the visual viewport), and on iOS it is lifted by `--kb` (`keyboardInset`). A focused field
  scrolls into view, and nothing sticky covers it.
- **Stale reminders:** a `decision_stale` reminder is listed only while its decision is open and not
  listed itself.
- All new labels are in the EN and AR catalogues (namespaced `item.*`). Numbers go through `ltr()`.

## Acceptance criteria

1. A `decision_stale` pin whose decision is open has `decisionId`. Its sheet shows the question and
   lets the operator answer. The answer resolves the decision and resumes its project. The pin is
   gone on the next load.
2. A decision pin opens the sheet with its options and a reply box. Each one answers through
   `/api/decision/answer`.
3. An alert pin's Acknowledge closes it.
4. A plan pin's Review shows the rendered plan, Download, Approve & build and Drop. Approve still goes
   through `/api/plan`.
5. `/md-file?view=html` refuses everything `/md-file` refuses (traversal, `..`, hidden, secret, non-md,
   outside roots, symlink out), with the same status. Raw HTML in the file is shown as text. The
   audit event is written.
6. The answer route refuses a closed decision, a plan card, an empty answer and an over-long answer.
   Without a session it is 401.
7. At a 390 px mobile viewport, the sheet's reply box can be focused and typed in, and Send answers.
   The rendered plan is readable without sideways scrolling (except code and tables, which scroll on
   their own).
8. EN and AR keys are complete. Numbers stay LTR.

## Edge cases

- The decision is answered elsewhere while the sheet is open: the answer route says "already
  answered", the console shows that and reloads the pins.
- The plan file is gone or too large: the sheet says so and keeps Approve and Drop (the operator may
  still decide). Download is shown only when the file is served.
- A `decision_stale` item whose decision has closed: the sheet shows the item and its own actions
  (dismiss), without an answer block.
- A pin of an unknown kind: the sheet shows the plain text and its hide control, never a blank page.
