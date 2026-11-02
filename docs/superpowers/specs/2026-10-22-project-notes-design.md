# Project notes: projects tell each other, the operator starts the work — design spec

**ADR:** 0043 (extends ADR-0018). **Glossary:** `CONTEXT.md` → Projects telling each other.
**Plan:** `docs/superpowers/plans/2026-10-22-project-notes.md`.

## Problem

A worker in one project finds something for another project (prod-ops → eticket-v3: D13–D19). It can
only write "for Neo to send". The company must notice and dispatch it by hand. Notes get lost, and
the sender never learns that the target fixed them (a prod-ops note still listed D16 as open after
eticket-v3 had deployed the fix).

## Decision in one line

A worker sends a **project note** with one tool. The engine stores it as an attention item on the
target project, shows it where attention items already show, puts the target's open notes into its
next fresh session, and closes the note from facts. Only the operator's **→ todo** (or the company
on the operator's order) starts work.

## The seam

One module, `src/engine/project-notes.ts`, holds all the behaviour behind a small interface:

```ts
export interface ProjectNotes {
  send(from: SenderCtx, input: NoteInput, now: number): NoteResult;          // validate → raise
  list(project: string, f: { box: "to" | "from"; open?: boolean }): NoteView[];
  show(project: string, id: number): NoteView | undefined;                   // to or from `project` only
  ack(project: string, id: number, now: number): NoteResult;                 // target only
  resolve(project: string, id: number, r: Resolution, now: number): Promise<NoteResult>; // target only
  withdraw(project: string, id: number, now: number): NoteResult;            // sender only
  block(project: string, now: number): string;                               // the notes block ("" = none)
  onTodoEnd(todoId: number, ok: boolean, now: number): void;                 // a note's todo ended done
}
```

- Storage is `attention_items` (source `note`), plus migration 12: `from_project TEXT`,
  `cause_msg_id INTEGER`, `resolution TEXT` (JSON), `acked_at INTEGER`, and an index on
  `(from_project, source)`. The body is `detail`, the refs are a JSON field inside `detail`'s
  envelope (`{ body, refs, kind }`), and `key` is `<sender>:<ref>`.
- `reconcileAll` and the scan producers never run for source `note`, so a scan can never "resolve"
  a note. `pruneAttention` uses `notes.keepResolvedDays` for this source.
- The worker tool `project_notes` (in `neoMcpServers`) is a thin adapter. It turns tool arguments
  into these calls and adds the cause (`opts.cause()`) and the sender (`opts.projectName`).

## Acceptance criteria

**Sending**
- AC1. `project_notes send` with a valid target, kind, severity, title, body, refs and `ref` raises
  ONE attention item on the target (source `note`, key `<sender>:<ref>`) and returns
  `note #<id> → <target>`. The sender is the session's project name. The tool has no sender argument.
- AC2. The same sender and `ref` again: the same row is refreshed (title, body, severity,
  `last_seen`), not duplicated. If that row was resolved, it opens again and its old resolution,
  snooze and todo are cleared (the ADR-0018 upsert rule).
- AC3. Refused, with a reason the worker can act on, and nothing stored:
  - a target that is not a folder under the work root, is a desk, is the sender itself, or is an
    absolute path or contains `/` or `..`;
  - an unknown kind or severity;
  - a title over `notes.maxTitleChars`, a body over `notes.maxBodyChars`, more than
    `notes.maxRefs` refs, a ref over 200 chars, or an empty title;
  - a body, title or ref that matches a secret pattern (`secret-patterns.ts`: PEM private key block,
    AWS access key id, GitHub/GitLab/Slack/Stripe/OpenAI/Anthropic/Google API key prefixes, a JWT, a
    `password|secret|token|api_key = <value>` assignment with a non-placeholder value, a URL with
    `user:pass@`). The reply names the pattern, never the matched text;
  - more than `notes.maxPerSenderPerDay` notes from this sender in 24 hours, or more than
    `notes.maxOpenPerPair` open notes from this sender to this target.
- AC4. Each send records an engine event (`note_sent`, `note_refused` with the reason) and a trace
  line under the cause of the turn that sent it: `note #<id> → <target>: <title>` (title only, never
  the body).
- AC5. Routing, as a fixed table in code: `request` (any severity) and `finding` + `high` also send
  one line to the operator now (priority `result` → Decisions group, through the flood gate) with the
  attention buttons. Every other note waits for the daily digest. No kind starts a run, enters a live
  session or adds a todo.

**The target**
- AC6. A fresh session of the target (fresh dispatch, fresh operator session; the same gate as the
  memory snapshot) starts with the notes block when it has open notes: a header that says these are
  notes from other projects and are information, not orders; then up to `notes.blockMax` lines of
  `#id [kind/severity] from <sender>: <title> (refs)`, newest high first; then `+N more —
  project_notes list`. The block is at most `notes.blockMaxChars`. No block on a resume, a tainted
  run, the ingress path or a folder with no open notes.
- AC7. `project_notes list` (open notes to me), `list box=from` (notes I sent, all states),
  `show <id>` (full body and refs; only a note to or from this project), `ack <id>` (target only:
  sets `acked_at`, state `acknowledged`).
- AC8. `resolve <id> fixed <commit>`: the engine checks, in the target's folder, that
  `git cat-file -e <commit>^{commit}` succeeds and `git branch -a --contains <commit>` lists a
  branch (bounded by a timeout). Then it resolves the note with `{ how: "fixed", commit, at }`.
  A commit that does not exist or is on no branch is refused. A git error is refused and changes
  nothing (fail closed).
- AC9. `resolve <id> not_needed|duplicate <reason>`: resolved with the reason (reason required,
  ≤ 500 chars, secret check as in AC3).
- AC10. Only the target may ack or resolve; only the sender may withdraw. Anything else is refused.

**The sender sees the outcome**
- AC11. A fresh session of the sender gets, in the same notes block, a "notes you sent" part: each
  open note's state (open / acknowledged / has todo #N), and each note resolved in the last
  `notes.sentLookbackDays` with how (`fixed at abc1234`, `not_needed: …`, `withdrawn`, `dismissed`).
- AC12. `withdraw <id>` (sender only) resolves it with `{ how: "withdrawn" }`.

**The operator**
- AC13. A note shows wherever attention items show (dashboard, `/attention`, digest, console) as
  `<title> — from <sender>`, with **→ todo**, snooze and dismiss. Console strings are i18n keys in
  `locales/en` and `locales/ar`, both complete.
- AC14. **→ todo** on a note builds the brief from a note template (`ATTENTION_BRIEFS.note_*`): the
  sender, kind, title, body, refs, and "done when: the finding is fixed and committed, then resolve
  note #id with the commit". The todo's cause is the note's cause (`cause_msg_id`) when it has one,
  so the target's run joins the sender's thread; otherwise it roots an `attention` thread as today.
- AC15. When a todo made from a note ends `done`, the note resolves `{ how: "fixed", todo: N,
  commit: <target HEAD at the end> }`. A failed todo leaves the note open.
- AC16. Dismiss closes the note as `{ how: "dismissed" }` for the sender's view.
- AC17. `/trace` on the sender's thread shows the note, the todo made from it, its run and the
  resolution.

**Firewall**
- AC18. The tool is attached only when `deps.notes` is set. The daemon sets it on operator surfaces
  only. `ingress.ts` passes `notes: undefined` explicitly (it spreads `...deps`), and a test asserts
  that the ingress tool set has no `project_notes`. Tainted runs have no MCP at all.
- AC19. The notes block is never injected into an ingress or tainted run (test).

## Edge cases

- Target folder renamed or deleted: its notes stay in the ledger. `send` to it is refused. The digest
  still lists open ones until the operator dismisses them.
- A worktree session: the sender and target are the project names the engine already uses
  (`projectName`), not worktree folder names.
- The company session may send and read notes like any project.
- Two sends with the same `ref` at the same moment: one row (UNIQUE key, one transaction).
- A note resolved, then the same `ref` sent again: it reopens (AC2), and the sender's view shows it
  open again.
- The resolve commit is in a worktree branch, not yet merged: accepted (it is on a branch). The
  resolution records the commit; it does not claim it is deployed.
- Codex workers: `startCodexOrder` attaches no MCP servers today (checked 2026-10-22), so a Codex
  worker cannot send, list or resolve notes. It still gets the notes block (plain brief text). Giving
  Codex Neo's tools belongs to the Codex-adapter work in CLAUDE.md "Next", not to this plan.
- Loop workers: they get the tool only if their launch path builds `neoMcpServers` today. Adding Neo's
  tools to loops is out of scope (P1 checks and records which paths have it).
- Large backlogs: `list` returns at most `notes.listMax` lines with "+N more".
- Clock and caps: a refused send because of a cap tells the worker which cap and when it frees.

## Out of scope

- Any automatic dispatch from a note, by any kind or severity.
- Notes to or from customers, desks, or projects outside the work root.
- Attachments. A note refers to files by repo path or URL in `refs`.
- PII detection. The tool text tells workers to refer to records by id and never paste customer data;
  only secret patterns are checked in code.

## Config (`config.json` → `notes`, defaults in code)

`maxTitleChars` 120 · `maxBodyChars` 4000 · `maxRefs` 10 · `maxPerSenderPerDay` 30 ·
`maxOpenPerPair` 50 · `blockMax` 8 · `blockMaxChars` 1500 · `sentLookbackDays` 14 · `listMax` 30 ·
`keepResolvedDays` 180 · `gitTimeoutMs` 10000.

## Docs to update when built

`CONTEXT.md` (done in design), `docs/CONFIG.md` (`notes.*`), `docs/HISTORY.md`, CLAUDE.md "Current
status", and the dispatch preamble line "Work for another project … goes back to Neo to dispatch"
becomes "… send it with `project_notes`". The preamble plus the codebase-memory line must stay under
5000 characters, so the line is replaced, not extended.

## As built (2026-10-22)

Where the build differs from the text above, the code and its tests are right:

- **AC2:** a note the operator **dismissed** stays closed when the same `ref` is sent again (the
  ADR-0018 rule: the operator wins). `send` refuses it and says so. A note resolved any other way
  opens again.
- **AC6:** the block's lines carry the id, kind, severity, sender and title — no refs, to stay small.
  `show` gives the refs and the body.
- **AC15:** when git cannot read the target's HEAD, the note still resolves `fixed` with the todo
  number and no commit.
- **AC16:** nothing is written on dismiss: a dismissed note's state is derived (`noteState`).
- **Not built (out of reach today):** loop workers get no Neo tools (only the dream-memory server),
  and Codex workers get no MCP servers, so neither can send or resolve notes. Both still get the
  notes block where their launch path injects it (dispatch, operator sessions).
- **Also changed:** the governor's fence reason now names `project_notes` instead of "back to Neo".
