# Design: always-on company · 24h normal idle · per-project trust · file transfer

**Date:** 2026-06-20
**Status:** approved (brainstorming) — ready for implementation plan

## Problem

Three operator pain points, plus one capability gap:

1. The always-on default project ("the company", rooted at `/home/neo/agent`) does **not**
   actually stay on. `sweepIdle` removes any `idle`/`running` session older than 10 min — the
   pinned default included — so after 10 min of quiet the company is swept out of the registry and
   `getDefault()` returns nothing. Free-text orders with no active project then have no home.
2. Normal projects close after only 10 min of quiet — too aggressive. They should stay awake for
   at least 24 h with no activity.
3. Every risky tool prompts the operator for Allow/Deny **every time**. The operator wants a
   persisted "trust" state so they are not asked each time.
4. Neither frontend can move files. The operator wants to attach files to a project, and to receive
   files a worker produces — on **both** Telegram and the web console.

## Decisions (locked during brainstorming)

- **Trust = full auto-approve.** When a project is trusted, the engine auto-approves *every* tool,
  including the otherwise-escalated set (deploy, delete, `git push`, payments, sending to real
  people). The operator outranks the `CLAUDE.md` "never auto-approve" line and has chosen this
  explicitly. The **customer→Gemini firewall is untouched** — it is a separate code path
  (`provider-router`), and customer work never carries trust.
- **Trust is per-project**, keyed by folder path.
- **Trust is off by default**, turned on once via a command, and **persisted** across restarts.
- **Audit replaces the human gate.** Because trust removes the human approval, the engine *records*
  every auto-approved action (the "AI decides, engine records" invariant), and shows the operator a
  non-blocking FYI line.
- **File transfer is bidirectional** on both frontends.

## Non-goals (YAGNI)

- Per-command "always allow *this exact* command" granularity.
- Expiring / time-boxed trust.
- Any trust for customer (`source:"customer"`) work — forbidden by the firewall.
- Telegram video/voice/audio inbound (document + photo only for MVP).
- Tiered trust (auto-approve some, still escalate others) — the operator chose full auto-approve.

---

## Part 1 — The company never goes off

**`src/engine/idle.ts` — `sweepIdle`:** skip the default project. A session whose
`id === registry.getDefault()?.id` is never interrupted, closed, or removed, regardless of age.

**`src/engine/commands.ts` — `killSession` / `killProject`:** refuse to kill the default project,
returning a message like `the company is always-on and can't be stopped`.

**Result:** `getDefault()` always resolves; the company stays registered and resumable forever.

**Tests:**
- `sweepIdle` leaves an old default session in the registry; removes an old normal session.
- Killing the default project is refused; killing a normal project still works.

---

## Part 2 — Normal projects awake ≥ 24 h

**`src/config.ts`:** add `idleCloseMs: number` to `NeoConfig`, default `24 * 60 * 60 * 1000`,
overridable via `config.json` (and env if we add a key later). Keep `IDLE_POLL_MS` as-is.

**`src/daemon.ts`:** use `cfg.idleCloseMs` instead of the hardcoded `IDLE_CLOSE_MS`. Update the
startup log line accordingly.

**`src/engine/pipeline.ts` — `startSession`:** the `onMessage` handler also calls
`registry.touch(registryId, now())`, so a project actively *producing output* counts as active.
This makes "no activity for 24 h" literally true and prevents a long autonomous task from being
interrupted mid-work just because the operator has not typed.

**Tests:**
- `loadConfig` default `idleCloseMs` is 24 h; `config.json` overrides it.
- A session that emitted output within the window is not swept; one quiet past the window is.

---

## Part 3 — Per-project trust (full auto-approve)

### Trust store

**New `src/engine/trust.ts`:**

```ts
export interface TrustStore {
  isTrusted(folder: string): boolean;   // absent ⇒ false (off by default)
  setTrust(folder: string, on: boolean): void;
  list(): string[];                     // trusted folders
}
export function openTrustStore(path: string): TrustStore; // bun:sqlite
```

Backed by its own `data/trust.db` (`CREATE TABLE IF NOT EXISTS trust(folder TEXT PRIMARY KEY)`).
`setTrust(folder, true)` = `INSERT OR IGNORE`; `setTrust(folder, false)` = `DELETE`. Untrusted is
the absence of a row.

### Enforcement (engine, frontend-agnostic)

**`src/engine/session-runner.ts`:**
- `RunHandlers` gains `autoApprove?: () => boolean` and `onAutoApprove?(reason: string): void`.
  `autoApprove` is **resolved per escalation** (a thunk, not a snapshot) so flipping `/trust on`
  affects an already-running, waiting worker. Both stay on `RunHandlers` so `buildCanUseTool(handlers)`
  keeps a single source.
- In `buildCanUseTool`: when `decide()` returns an `escalate` verdict **and** `autoApprove()` is
  true → return `{ behavior: "allow", updatedInput: input }` and call `handlers.onAutoApprove(reason)`.
  Otherwise the existing `onEscalation` path runs unchanged. Safe/allowed tools are unaffected.

**`src/engine/pipeline.ts`:**
- `PipelineDeps` gains `trust: TrustStore`.
- `startSession` wires `autoApprove: () => deps.trust.isTrusted(order.folder)` and
  `onAutoApprove: (reason) => { ledger.recordAutoApproval(order.id, reason); deps.reply(chatId,
  \`🔓 auto-approved: ${reason}\`, project); }`.
- `dispatch.ts`'s `dispatchToProject` gets the same wiring for sub-projects (a trusted sub-project
  folder auto-approves; otherwise escalates as today).

### Audit

**`src/engine/ledger.ts`:** add table
`auto_approvals(order_id TEXT, reason TEXT, at INTEGER)` and `recordAutoApproval(orderId, reason)`.
This is the compensating control now that the human gate can be bypassed.

### Command

**`src/engine/commands.ts`:**
- `CommandDeps` gains `trust: TrustStore`.
- New `/trust` command:
  - `/trust` → status: whether the chat's active project is trusted, plus the list of trusted
    folders and usage hint.
  - `/trust on` / `/trust off` → toggle trust for the chat's active project
    (`findByChat(chatId) ?? getDefault()`), echoing the resulting state.
- `/list` marks trusted projects with a 🔓.

**Both frontends** route through `handleCommand`, so Telegram and the web console both get `/trust`
with no per-frontend logic. `src/daemon.ts` constructs the `TrustStore` and threads it into the
Telegram frontend, the web `EngineDeps`, and `dispatch`.

**Tests:**
- Trust store: off by default; `setTrust` on/off roundtrips; `list` reflects state; survives reopen.
- `buildCanUseTool`: escalates when untrusted; auto-allows + calls `onAutoApprove` when trusted;
  never auto-approves a safe tool differently (still allowed) — and the thunk is read at call time.
- `recordAutoApproval` persists.
- `/trust on` then `/trust` reports trusted; `/trust off` reports untrusted.

---

## Part 4 — File transfer both ways

Largest slice; sequenced **last**. Engine owns the logic; frontends stay thin I/O. Outbound mirrors
the existing in-process MCP-tool pattern in `dispatch.ts`.

### Inbound (operator → project)

**New `src/engine/files.ts`:**

```ts
export function saveInbound(folder: string, filename: string, bytes: Uint8Array): string;
```

Sanitizes `filename` (strip path separators / unsafe chars), writes to `<folder>/inbox/<name>`,
dedupes on collision (`name`, `name-2`, …), returns the absolute saved path. The target folder is
the chat's active project (`findByChat(chatId) ?? getDefault()`), resolved by the caller.

**Telegram (`src/frontends/telegram.ts`):** add `bot.on("message:document")` and
`bot.on("message:photo")` (operator-gated like text):
- Resolve the active project folder.
- Download bytes via `ctx.getFile()` → `https://api.telegram.org/file/bot<token>/<file_path>`.
  Photos: pick the largest size; synthesize a name (`photo-<id>.jpg`). Documents: use `file_name`.
- `saveInbound`, then `handleMessage` with augmented text:
  `📎 operator attached \`<name>\` at \`<path>\`\n<caption>`.

**Web (`src/frontends/web.ts` + `web-channel.ts`):**
- New session-gated `POST /upload` (multipart `formData`): resolve active folder, `saveInbound`,
  then `channel.send` the same augmented text.
- UI: a 📎 button next to the composer that POSTs the file.

### Outbound (project → operator)

**New in-process MCP tool `send_file(path, caption?)`**, wired to **every** session. Consolidate the
builders: one `neoMcpServers(deps, chatId, { dispatch }: { dispatch: boolean })` that always
includes `send_file` and includes `dispatch` only for the company. `runConfigFor` calls it with
`dispatch: registry.getDefault()?.id === id`.

- **Security:** the tool resolves `path` against the session's project folder and rejects anything
  outside it (`resolve(path)` must start with `resolve(folder) + sep`). A worker can only send files
  it produced.
- Calls a new `PipelineDeps.sendFile(chatId, path, caption?)`:
  - **Telegram:** `bot.api.sendDocument(chatId, new InputFile(path), { caption })`.
  - **Web:** `channel.sendFile(path, caption)` → register a short-lived `token → path`, emit
    `WebEvent { type:"file", name, url:"/file?token=…", project? }`. New session-gated `GET /file`
    serves the bytes by token. UI renders a download chip in the feed.

**`src/engine/web-channel.ts`:** add the `file` event type, a `sendFile(path, caption?)` method, and
a `getFile(token)` lookup for the route. `PipelineDeps.sendFile` for the web channel forwards to it.

**Tests:**
- `saveInbound`: sanitizes names, writes under `inbox/`, dedupes collisions.
- `send_file` tool: allows a path inside the folder, rejects a path outside it, calls `sendFile`.
- `web-channel`: `sendFile` emits a `file` event and `getFile(token)` returns the path; unknown
  token returns undefined.

---

## Architecture summary

```
operator (Telegram / web)
   ↕  text + files (📎 in, download out)
Engine
   trust.ts  ──► canUseTool autoApprove thunk ──► auto-allow + ledger.recordAutoApproval
   idle.ts   ──► skips getDefault(); 24h cutoff from cfg.idleCloseMs
   files.ts  ──► saveInbound(folder,…)            (inbound)
   send_file MCP tool ──► PipelineDeps.sendFile   (outbound, path-confined)
   ↕  query({ cwd, canUseTool, mcpServers, … })
Worker (Claude Agent SDK)
```

## Files touched

- `src/engine/idle.ts` — skip default in sweep.
- `src/engine/commands.ts` — protect default from `/kill`; add `/trust`; 🔓 in `/list`; `CommandDeps.trust`.
- `src/config.ts` — `idleCloseMs` (default 24h).
- `src/daemon.ts` — use `cfg.idleCloseMs`; construct + thread `TrustStore`; thread `sendFile`.
- `src/engine/pipeline.ts` — `trust` + `sendFile` deps; `autoApprove`/`onAutoApprove` wiring; `touch` on output.
- `src/engine/session-runner.ts` — `onAutoApprove`, `autoApprove` thunk in `buildCanUseTool`.
- `src/engine/ledger.ts` — `auto_approvals` table + `recordAutoApproval`.
- `src/engine/dispatch.ts` — consolidate into `neoMcpServers` (dispatch + `send_file`); trust for sub-projects.
- `src/engine/web-channel.ts` — `file` event, `sendFile`, `getFile`.
- `src/frontends/telegram.ts` — document/photo inbound; `sendFile` via `sendDocument`.
- `src/frontends/web.ts` — `POST /upload`, `GET /file`, composer 📎 button, file-chip rendering.
- **New:** `src/engine/trust.ts`, `src/engine/files.ts`.

## Verification

- TDD per piece; `bun test` + `bunx tsc --noEmit` green before any piece is "done".
- Manual after wiring: `/trust on` → risky command runs with no prompt and an FYI line + ledger row;
  `/trust off` → prompts again. Attach a file in Telegram and web → lands in `<folder>/inbox/`.
  Have a worker call `send_file` → arrives in both channels.

## Implementation order

1. Part 1 (always-on company) — smallest, fixes a live bug.
2. Part 2 (24h idle) — config + one touch.
3. Part 3 (trust) — store, enforcement, audit, command.
4. Part 4 (files) — inbound then outbound, both frontends.
