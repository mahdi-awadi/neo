# Explicit-active routing — make free-text orders reach the right place every time

- **Date:** 2026-06-22
- **Status:** Approved (design) — ready for an implementation plan
- **Branch:** builds on `feat/trust-idle-files`

## Problem

When the operator sends a plain-text order, it sometimes opens and dispatches to a project and
sometimes silently lands somewhere else. The operator reported the inconsistency for two states
they expect to behave **identically**: "I picked no project" and "I picked the agent (company)
project." In both cases they want the company/agent to receive the order, turn it into a prompt,
and dispatch it to the correct project — every time.

## Root cause

The inconsistency is in **deterministic engine routing**, not (only) AI flakiness.

`handleMessage` resolves the follow-up target as:

```ts
const live = registry.findByChat(chatId) ?? registry.getDefault();
```

`registry.findByChat(chatId)` does two things (`src/engine/registry.ts`):

1. Return the **explicitly selected** active session for the chat (the `active` map), if still open.
2. **Otherwise fall back to the most-recently-open session for that chat.**

Step 2 is the bug. Real projects are added to the registry by `/open` with the operator's real
`chatId`, but `/open` never marks the project as the *active selection*. So after the operator opens
any project, that project lingers as the "most recent open" session and **silently captures**
later free text as a **raw follow-up** — no dispatch, no crafted prompt — even though the operator
believes they "picked no project."

The two states the operator named therefore diverge:

- **Agent/company explicitly selected** → `findByChat` returns the company → free text resumes/
  follows up the company worker → it dispatches and crafts a brief. ✓
- **No project selected** → `findByChat` finds no explicit selection, falls back to a lingering
  real project → free text follows up *that* project raw. ✗ (no dispatch, wrong target)

## Goals

- "No project selected" and "agent/company selected" route **identically** — both to the company
  dispatcher.
- A real project receives a free-text follow-up **only when it is the operator's explicit
  selection** (`/open`, `/use`, `/list` tap, or the reply-gesture).
- No silent capture of free text by an idle background project.
- Preserve fast in-project follow-up: after `/open <folder> <task>`, "also do Y" still reaches that
  project.

## Non-goals

- Changing the customer/ingress (`source != "neo"`) routing.
- Changing how dispatched sub-projects run (they use `chatId = SUB_CHAT = -2` and never touch the
  operator's selection).
- Auto-deselecting a project when it goes idle (a selected project stays selected and resumes on
  follow-up, as today). Returning to the company is done by selecting the agent or killing the
  project — the two states the operator already uses.
- Guaranteeing the company *decides* to dispatch — that is an AI decision. This spec guarantees the
  order *reaches* the company consistently; the company-prompt tightening (Part B) raises the
  dispatch hit-rate but is not the deterministic core.

## Design

### Part A — engine (deterministic, the real fix)

**A1. Add `registry.getActive(chatId)`** — returns only the explicitly pinned selection, with **no
most-recent fallback**:

```ts
getActive(chatId) {
  const id = active.get(chatId);
  const s = id ? sessions.get(id) : undefined;
  return s && OPEN.has(s.status) ? s : undefined;
}
```

Because it goes through `OPEN.has(status)` and `sessions.get`, a selected project that was killed/
removed or closed yields `undefined` automatically — no stale capture.

**A2. Route free text by explicit selection** (`src/engine/pipeline.ts`, `handleMessage`):

```ts
const live = registry.getActive(chatId) ?? registry.getDefault();
```

- No selection → company → dispatch + crafted prompt.
- Agent/company selected → company → dispatch + crafted prompt.
- Real project selected → follow up / resume that project (unchanged behavior).

**A3. `/open` marks its project active** (`handleMessage`, the new-order path): after
`registry.add(parsed, now())`, call `registry.setActive(chatId, session.id)`. This keeps natural
follow-up working now that the most-recent fallback is gone, and makes `/open` consistent with
`/use`, `/list` tap, and the reply-gesture (which already call `setActive`).

**A4. Migrate the remaining `findByChat` callers to `getActive`, then remove `findByChat`.**
Callers (all currently `findByChat(...) ?? getDefault()` or `findByChat(...)?.id`):

| File | Use | After |
| --- | --- | --- |
| `src/engine/pipeline.ts` | free-text routing | `getActive ?? getDefault` |
| `src/engine/commands.ts` `renderList` | `★` active marker | `getActive` |
| `src/engine/commands.ts` `trustCommand` | `/trust` target | `getActive ?? getDefault` |
| `src/engine/dashboard.ts` | `★` active marker | `getActive` |
| `src/frontends/telegram.ts` | file-intake target | `getActive ?? getDefault` |
| `src/frontends/web.ts` | message/file target | `getActive ?? getDefault` |

After migration `findByChat` is unused; remove it from the `Registry` interface and implementation.
Net effect: one consistent notion of "the active project = the one you explicitly selected." The
`★` marker becomes truthful — its absence means "free text goes to the company."

Doc follow-up: `src/engine/default-project.ts` has a comment justifying the company's reserved
`chatId = -1` "so `findByChat()` never returns the default." With the most-recent fallback gone the
reservation is no longer load-bearing for routing (`getActive` is keyed by the `active` map, and the
company is only returned when explicitly selected — which is intended). Keep `chatId = -1` as a
harmless sentinel but update the comment so it doesn't reference the removed method.

### Part B — company reliability (prompt, complement)

Tighten the dispatch mandate so that once an order reaches the company it is reliably dispatched
with a faithful prompt:

- `dispatch` tool description (`src/engine/dispatch.ts`): reinforce that a project-bound order is
  **never** answered locally and the `task` brief must restate the operator's goal verbatim enough
  that nothing is lost.
- `/home/neo/agent/CLAUDE.md` (runtime company prompt): same mandate in the chief-of-staff
  instructions.

Part B is prompt-level (not unit-testable); Part A is the deterministic guarantee.

## Behavior / edge cases

- **Kill/remove the selected project** → `getActive` returns `undefined` → free text goes to the
  company. The stale `active` entry is harmless (resolved away by the `OPEN`/`sessions.get` checks);
  optionally cleared in `remove` for tidiness.
- **Selected project goes idle** → still selected; free text resumes it (existing idle-resume path).
- **Reply-with-file** → the reply-gesture sets active before the file is saved, so the file still
  targets the replied-to project.
- **Dispatched sub-projects** (`chatId = -2`) → never in the operator's `active` map; unaffected.

## Testing (TDD — write tests first)

**Registry (`tests/registry.test.ts`):**
- `getActive` returns the explicitly selected session.
- `getActive` returns `undefined` when nothing is selected, **even if** a project is open for that
  chat (the key regression test for the silent-capture bug).
- `getActive` returns `undefined` when the selected session was removed or is closed.

**Pipeline (`tests/pipeline.test.ts`):**
- Free text with an open-but-unselected real project → routes to the **company**, not that project.
- After `/open <folder> <task>`, a subsequent plain message follows up the **opened** project
  (proves A3 preserves in-project follow-up).
- Selecting the agent/company and "no selection" produce the same routing outcome.

**Commands (`tests/commands.test.ts` or equivalent):**
- `renderList` `★` reflects the explicit selection (none selected → no `★`).
- `/trust` with no explicit selection targets the company.

All `bun test` green and `bunx tsc --noEmit` clean before the work is "done," committing per logical
piece, per `CLAUDE.md`.

## Out of scope / possible follow-ups

- A `/company` (or `/use` with no arg) shortcut to explicitly deselect back to the company.
- Auto-deselect-on-idle, if the operator later wants idle projects to stop resuming on free text.
