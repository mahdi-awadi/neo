---
approval: required
---
# Needs you vs housekeeping, pins, superseded items, tappable todos — plan

Spec: `docs/superpowers/specs/2026-10-29-needs-you-pins-todo-detail-design.md` (ADR-0065, proposed).
Branch `feat/needs-you-pins` from `dev` (worktree `/home/neo-wt-needs-you`, removed when done). TDD per
task; `bunx tsc --noEmit` and `bun test` green before each commit. Built on dev only: no merge, no restart.

Why approval: a ledger migration (v15 → v16: a `pins` table and `attention_items.resolved_reason`), the
engine auto-resolving items, and the badge rule changes on every project.

- [ ] 1. **Migration v16** — `pins` table, `attention_items.resolved_reason`; ledger `setPin`, `listPins`,
   `resolveAttention(id, reason)`. Test: a v15 ledger migrates, old rows read, pins round-trip.
- [ ] 2. **`attentionClass`** — the kind table, fail-closed default; a coverage test over every producer kind
   (github, git, engine, note, restart, skillify, probe).
- [ ] 3. **`needsYou()`** — waiting work (owner operator) + failed todos + needs-you items + pins − unpinned.
   Tests: the live mix gives none; plan, decision, alert, failed todo, unknown kind each give one; pin and
   unpin.
- [ ] 4. **Badge + project view** — `projectHealth` reads the needs-you count; `ProjectView` gains `needsYou`
   and `housekeeping`; project card count "N need you"; `/attention` and the digest lead with needs-you.
   Tests: acceptance 1–2.
- [ ] 5. **Superseded items** — `supersede.ts` (stem + numeric version compare), run after each scan,
   resolve with reason; event `attention_superseded`. Tests: the agent-sdk series, `0.3.10` > `0.3.9`,
   a single item, a non-versioned branch, a dependency PR series.
- [ ] 6. **API** — `GET /api/needs-you`, `POST /api/pin`, `GET /api/todo/:id` (summary, brief capped, project,
   lane, status, times, result or last note, links, allowed actions). Tests: shapes, unknown id 404, bad
   body 400, pin of a resolved item refused.
- [ ] 7. **Console: `act()` + toasts** — one helper for every button (pressed, busy, disabled, toast with the
   reply); migrate every existing button (todo, attention, plan, loop, thread close, sdk, tool control).
- [ ] 8. **Console: pinned strip** — under the tab bar on every tab; count chip; collapsible; 5 + "show all";
   action buttons; pin/unpin controls on attention items and todos.
- [ ] 9. **Console: project page split + todo detail** — Needs you first, Housekeeping (N) collapsed; todo
   rows in the Queue tab and project QUEUE are buttons opening the detail view (pressed + loading state;
   cancel/retry/up via `act()`).
- [ ] 10. **i18n** — `needs.*`, `pin.*`, `todo.detail.*`, `toast.*` in EN + AR; key-parity test; numbers and
   ids LTR.
- [ ] 11. **Docs** — ADR-0065 accepted (as built), CONTEXT.md (done in design), HISTORY.md, HANDOFF.md.
- [ ] 12. **Verify** — full suite; Playwright at 390 px in EN and AR: Projects list, project page split, the
   strip, todo detail, a toast; the screenshots go to the operator; independent code review; fix findings.
