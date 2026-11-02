# A pin's Open lands on the item, and a plan is read before it is approved

**Status:** accepted (2026-10-30, built on dev, restart-gated). Spec:
`docs/superpowers/specs/2026-10-30-pin-open-lands-where-it-can-be-acted-on.md`. Amends ADR-0065 (the
strip's actions) and ADR-0046 (its rejected preview pane is now built). Related: ADR-0025 (safe Markdown),
ADR-0049 (decision cards), ADR-0054 (who may close a decision).

## Context

On the operator's phone (2026-10-30), the strip held one item: "Should I write a plan to cut the mem…".
Tapping Open showed the neo project page. The question was not there, and nothing could be answered or
typed. Plan pins approved in one tap, and the plan could not be read first. Root causes, checked in the code:

1. `pinAction` opened a todo, else a thread, else the project page. An attention item has neither a
   todo nor a thread. The item was a `decision_stale` reminder whose key is an open decision, and the
   needs-you list never linked the two. The operator had hidden the decision itself, so only the
   reminder showed.
2. The console had no way to answer a decision. `answerDecision` was wired only to Telegram and to plan
   approval. A message typed in the thread reached the project but left the decision open.
3. `/md-file` (ADR-0046) only downloads, and the plan button approved without showing the plan.

## Decision

1. **Open shows the item itself** in the existing sheet (the todo detail's `<dialog>`), from one seam,
   `itemDetail` (`src/engine/needs-you-detail.ts`, `GET /api/item?ref=`):
   - **Decision:** the full question and its card. The view says how it is closed (`closedBy`). A
     governor approval shows a hint (Allow/Deny on its Telegram card), never a reply box that cannot work. A one-choice card answers with a tap. A card with
     several questions or a multi-select one uses picks and one Submit. Every decision also has a reply box.
   - **Plan:** the plan rendered, Download .md, Approve & build, and Drop (confirmed). The strip's button
     says **Review**: no plan is approved unread.
   - **Attention item:** the project page's own renderer and buttons. A `decision_stale` reminder also
     carries the decision it is about, answerable in place.
   - Retry on a failed todo stays one tap, and a todo keeps its own sheet.
2. **The console answers through the Telegram path:** `POST /api/decision/answer` calls
   `reply-routing.answerDecision` and resumes the project through `handleMessage`.
   - **Shared refusal rule:** `textAnswerRefusal` (decision-settle.ts) is shared with the company's
     `decision` tool. An approval (no order) is closed only by its card's Allow/Deny, which releases the
     waiting tool call. A plan card follows its plan.
   - **Alerts and picks:** an alert's Acknowledge dismisses it and resumes nothing. Picks are joined by
     `structured-question.answerText`, like a Telegram Submit.
   - **Length cap:** an answer may be up to `TELEGRAM_MAX` characters, the same bound a Telegram answer has.
3. **A stale reminder never duplicates its decision.** It is listed only while its decision is open and
   not listed itself (the operator hid it). Once the decision is answered, the reminder is gone.
4. **The plan is rendered by `/md-file?view=html`:** the same `resolveMdFile` checks, the same audit
   event (marked `view`), and the console's one safe renderer (`mdToHtml`, web target). No second
   file-read path and no second viewer. Rendering runs on the engine's one thread, so it has its own
   cap: a file over `mdFiles.viewMaxBytes` (default 256 KiB) is refused (413) and can still be
   downloaded. A render whose `Sec-Fetch-Site` is not `same-origin` is refused (403), because a GET is
   not covered by the non-GET CSRF check.
5. **Typing on a phone:** the sheet's height follows the visual viewport (`--app-h`). On iOS, which does
   not resize the layout for the keyboard, the sheet is lifted by `--kb` (`viewport.ts`,
   `keyboardInset`). A focused field is scrolled into view, and the reply box uses 16 px text so iOS does
   not zoom.
6. **CSRF:** every non-GET request whose `Sec-Fetch-Site` is not `same-origin` is refused (403), because
   a `SameSite=Lax` cookie still reaches a sibling subdomain on this public host. A browser that sends
   no such header keeps the SameSite protection.
7. **A mobile test in a real browser:** `tests/console-pins-mobile.e2e.test.ts` (Playwright, pinned
   `playwright-core` dev dependency, using the local Chromium) runs the real console
   (`tools/console-demo`, 127.0.0.1 only, in-memory, fake worker) at 390 px, in English and Arabic. It
   is skipped when that browser is not installed.

## Rejected

- **Keep Open on the project page and add an answer box there.** The project page is a dashboard of
  many items; a pin is one item. The operator would still have to find it.
- **Open the decision's thread.** A thread has no answer control, and many items have no thread.
- **Answer by typing in the thread.** That message reaches the project but closes nothing, so the pin
  would stay. Making thread text close decisions would guess which decision it answers.
- **A client-side Markdown renderer (or a second viewer page).** It would be a second renderer to keep
  safe. The server renderer already shows raw HTML as text and drops unsafe links (ADR-0025).
- **Approve from the strip, with the plan a tap away.** The operator asked to read before deciding;
  one-tap approve is how plans were approved unread.
- **A Playwright test through the shared browser service (ADR-0032).** It runs in Docker and cannot
  reach a console bound to 127.0.0.1; binding the demo to a public address is not acceptable on this
  host.
- **An Origin header check for CSRF.** Behind the proxy, the request host is not the public origin;
  `Sec-Fetch-Site` is decided by the browser and needs no host configuration.

## Known limits

- **Plans the console cannot serve:** a plan in a worktree outside `mdFiles.roots` (for example under
  `/tmp`) is refused, and the sheet shows the reason. Approve and Drop still work.
- **Refusal texts:** the engine's refusal reasons (for example "already answered") are English in the
  Arabic console. The labels and hints are translated.
- **Concurrent answers:** `resolveDecision` does not check the row's status. The console checks and
  answers with no wait in between, but two surfaces answering at the same moment could both resume the
  worker. This is not changed here; it applies to Telegram too.
