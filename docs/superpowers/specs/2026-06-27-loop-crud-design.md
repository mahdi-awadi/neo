# Spec — Data-driven loop CRUD (author loops from the frontend, no restart)

- **Status:** Draft for review
- **Date:** 2026-06-27
- **Topic:** Make loop *definitions* data (not just code) and expose create/edit/delete/enable from the admin web console.
- **Builds on:** `docs/superpowers/specs/2026-06-26-loop-runtime-design.md` (the loop runtime this extends).

## 1. Why

The loop runtime works, but loop *definitions* are a static code array (`LOOPS` in `src/engine/loops.ts`) loaded once at daemon start. Adding a loop means editing source + restarting the live engine. Enable/disable and last-run are already *data* (ledger, hot-read each tick) — definitions are the last thing still hard-coded.

CLAUDE.md frames loops/automations as **Neo's product model** (operators spin up automations). So definitions should be **data**: authored at runtime from the admin console, live within one scheduler tick, no restart.

## 2. Goals / Non-goals

**Goals**
1. Loop definitions become data: effective library = **built-in loops (code) ∪ custom loops (ledger)**, read fresh on every tick and every `/loop`.
2. Full CRUD on **custom** loops (create / edit / delete / enable) from the **admin web console**; built-ins are run/toggle-only.
3. Validation that turns untrusted form input into a safe `LoopDef` or a clear error.
4. Run + on/off keep working on any loop (built-in or custom) from both web and Telegram, via the merged set.

**Non-goals (deferred — reuse this same data layer later)**
- **Telegram `/loop new` guided flow.** Telegram keeps its existing run + on/off.
- **Agent/MCP `create_loop` tool** (let a worker author loops).
- **Versioning / history of edits.** Edit overwrites; delete removes.
- Editing or deleting **built-in** loops.

## 3. Architecture overview

```
web "New loop" form ─POST /api/loop/create─▶ web-channel.createLoop(input)
                                                  │ validateLoopInput(input)  → LoopDef | error
                                                  ▼ ledger.saveLoopDef(name, JSON.stringify(def))
ledger.loop_defs (name, json)  ◀── dumb string persistence (ledger stays lean)
        ▲
        │ effectiveLoops(ledger) = BUILTINS ∪ parse(ledger.listLoopDefs())
        ├──▶ scheduler tick (daemon, every 60s)  → custom cron loops fire at their time
        ├──▶ listLoops(ledger) / matchLoop(name, ledger)  → run · on/off · dashboard
        └──▶ Telegram /loop & web Loops tab
```

Layering keeps `ledger.ts` import-light (it only ever sees strings) and avoids cycles: validation imports the `LoopDef` **type** only.

## 4. Detailed design

### 4.1 Data layer — `ledger.ts` (dumb string persistence)
A new table + three methods on the `Ledger` interface (string-typed, no new imports):
```sql
CREATE TABLE IF NOT EXISTS loop_defs (name TEXT PRIMARY KEY, json TEXT NOT NULL);
```
```ts
saveLoopDef(name: string, json: string): void;   // upsert
listLoopDefs(): Array<{ name: string; json: string }>;
deleteLoopDef(name: string): void;               // also deletes the loop_state row for `name`
```

### 4.2 Validation — `src/engine/loop-validate.ts` (new, pure)
```ts
export interface LoopInput {
  name: string; summary: string; folder: string; prompt: string;
  goalKind: "command" | "judge";
  goalCommand?: string;   // command: a shell one-liner, wrapped as ["sh","-c", cmd]
  goalCriteria?: string;  // judge: the criteria text
  goalTimeoutMs?: number;
  triggerKind: "manual" | "interval" | "cron";
  intervalMinutes?: number; // interval
  cronExpr?: string;        // cron
  maxIterations: number; budgetUsd?: number; enabledByDefault?: boolean;
}

export function validateLoopInput(
  input: LoopInput,
  opts: { existingNames: string[]; folderOk?: (folder: string) => boolean },
): { def: LoopDef } | { error: string };
```
Rules: `name` normalizes to a kebab slug, must be non-empty and not in `existingNames`; `folderOk(folder)` (default: exists, is a dir, resolved path under `/home/`) must pass; `command` needs a non-empty `goalCommand`, `judge` a non-empty `goalCriteria`; `interval` needs `intervalMinutes>0` (→ `everyMs`), `cron` needs `isValidCron(cronExpr)`; `maxIterations≥1`, `budgetUsd≥0` if present. On success it builds a `LoopDef` (`usage: "/loop <name>"`, goal/trigger/bounds normalized). `folderOk` is injectable so tests need no real dirs.

`src/engine/trigger.ts` gains `isValidCron(expr: string): boolean` (5 fields, each parses to in-range numbers).

### 4.3 Registry merge + CRUD — `src/engine/loops.ts`
```ts
export interface LoopDefStore {
  listLoopDefs(): Array<{ name: string; json: string }>;
  saveLoopDef(name: string, json: string): void;
  deleteLoopDef(name: string): void;
}

export const BUILTINS: LoopDef[];               // the four code loops (was LOOPS)
export function isBuiltin(name: string): boolean;
export function effectiveLoops(store?: LoopDefStore): LoopDef[]; // BUILTINS ∪ parsed custom (custom can't shadow a builtin)
export function listLoops(store?: LoopDefStore): LoopInfo[];     // now over effectiveLoops
export function matchLoop(name: string, store?: LoopDefStore): LoopDef | undefined;

export function createLoop(input: LoopInput, store: LoopDefStore): { ok: true; def: LoopDef } | { ok: false; error: string };
export function updateLoop(name: string, input: LoopInput, store: LoopDefStore): { ok: true; def: LoopDef } | { ok: false; error: string };
export function deleteLoop(name: string, store: LoopDefStore): { ok: true } | { ok: false; error: string };
```
- `effectiveLoops` parses each custom JSON; a custom row whose name collides with a builtin is ignored (builtins win).
- `createLoop` → `validateLoopInput(input, { existingNames: effectiveLoops(store).map(name) })` → `saveLoopDef`.
- `updateLoop` rejects builtins; validates with `existingNames` excluding the loop's own name; overwrites.
- `deleteLoop` rejects builtins; else `deleteLoopDef`.
- `LoopInfo` gains `custom: boolean` and `triggerDesc: string` (e.g. `"cron 0 4 * * *"`, `"every 60m"`, `"manual"`); keeps `scheduled`, `enabled`.
- `matchLoop`, `handleLoop`, `startLoop` take/forward the store so Telegram run + on/off reach custom loops.

### 4.4 Web surface — `web-channel.ts` + `web.ts`
New `WebChannel` methods (mirroring `runLoop`), each calls the registry with `opts.engine.ledger` as the store and emits a refreshed `loops` event:
```ts
createLoop(input: LoopInput): { ok: boolean; error?: string };
updateLoop(name: string, input: LoopInput): { ok: boolean; error?: string };
deleteLoop(name: string): { ok: boolean; error?: string };
setLoopEnabled(name: string, on: boolean): void;   // ledger.setEnabled
```
New session-gated routes in `web.ts` (same `sessionUser(req)` gate as every `/api/*`): `POST /api/loop/create`, `/api/loop/update`, `/api/loop/delete`, `/api/loop/enable`, returning `{ ok, error? }`. The **Loops tab** gains a "New loop" form (name, summary, folder picker, prompt, goal kind+value, trigger kind+value, maxIterations, budgetUsd) and per-row controls: Run (exists), On/Off, and — for custom rows only — Edit and Delete. Plain HTML/JS matching the existing dashboard style.

### 4.5 Scheduler & dashboard read the merged set
- `daemon.ts`: the tick passes `loops: effectiveLoops(ledger)` (computed each fire) instead of static `LOOPS`, so custom cron loops fire. Wire the `store` for run/on-off in both frontends.
- `dashboard.ts`: `listLoops()` → `listLoops(ledger)` so `enabled`/`custom`/`triggerDesc` populate.

## 5. Governance
- **Admin-only:** every `/api/loop/*` route is behind the existing web session gate (TOFU admin). No new auth.
- **Folder fence:** `validateLoopInput` requires the folder under `/home/` — a created loop can't open a worker outside the tree (matches the dispatch guard).
- **Arbitrary shell caveat:** a `command` goal is shell the engine runs; acceptable because only the trusted admin can reach the form, and loop workers still **auto-deny escalations** (no push/deploy/rm). The judge goal stays read-only.
- No AI added to the engine; validation/merge/CRUD are deterministic.

## 6. File-by-file change map
| File | Change |
|---|---|
| `src/engine/ledger.ts` | `loop_defs` table + `saveLoopDef`/`listLoopDefs`/`deleteLoopDef` (deleteLoopDef clears loop_state) |
| `src/engine/trigger.ts` | `isValidCron(expr)` |
| `src/engine/loop-validate.ts` | **new** — `LoopInput`, `validateLoopInput` |
| `src/engine/loops.ts` | `LoopDefStore`, `BUILTINS`, `isBuiltin`, `effectiveLoops`, store-aware `listLoops`/`matchLoop`, `createLoop`/`updateLoop`/`deleteLoop`, `LoopInfo` (+custom/triggerDesc), store-threaded `handleLoop`/`startLoop` |
| `src/engine/web-channel.ts` | `createLoop`/`updateLoop`/`deleteLoop`/`setLoopEnabled`; `state()`/loops events over the merged set |
| `src/frontends/web.ts` | routes `/api/loop/{create,update,delete,enable}`; Loops-tab form + per-row controls |
| `src/engine/dashboard.ts` | `listLoops(ledger)` |
| `src/daemon.ts` | tick uses `effectiveLoops(ledger)` |
| `src/frontends/telegram.ts` | pass `store` into `handleLoop`/`matchLoop` (custom loops runnable/toggleable) |

## 7. Testing strategy (TDD)
- `loop-validate.test.ts` — name slug/blank/duplicate; folder rejected when `folderOk` false; command vs judge required fields; interval/cron validity; bounds floors; happy path builds the right `LoopDef`.
- `trigger.test.ts` — `isValidCron` accepts the library exprs, rejects 4-field/garbage/out-of-range.
- `loop-defs.test.ts` (ledger) — save/list/delete round-trip; `deleteLoopDef` clears loop_state.
- `loops.test.ts` — `effectiveLoops` merges + builtins win on name clash; `createLoop` persists + appears in `listLoops`/`matchLoop`; `updateLoop`/`deleteLoop` reject builtins; duplicate-name create errors.
- `web-channel.test.ts` — `createLoop` invalid → `{ok:false,error}` and nothing persisted; valid → persisted + a refreshed loops event; `deleteLoop`/`setLoopEnabled`.
- `scheduler.test.ts` — a custom cron loop in `effectiveLoops` fires when due.
- `web.test.ts` — `/api/loop/create` requires a session; returns `{ok}`.

Each task: `bunx tsc --noEmit` + `bun test` green before the next; commit per task.

## 8. Build sequence (TDD)
1. ledger `loop_defs` CRUD.
2. `isValidCron` (trigger).
3. `loop-validate.ts`.
4. `loops.ts`: `LoopDefStore`/`BUILTINS`/`effectiveLoops`/`isBuiltin` + store-aware `listLoops`/`matchLoop` + `createLoop`/`updateLoop`/`deleteLoop` + `LoopInfo` fields.
5. `web-channel.ts` CRUD methods.
6. `web.ts` routes + Loops-tab UI.
7. Wire-through: `daemon.ts` `effectiveLoops`, `dashboard.ts`, `telegram.ts` store; full-suite green.

## 9. Risks
- **Module cycles** — avoided: ledger sees only strings; `loop-validate` imports the `LoopDef` *type* only; merge lives in `loops.ts`.
- **Bad custom JSON** (hand-edited DB) — `effectiveLoops` skips rows that fail to parse/validate rather than crash the tick.
- **Name collision** — create/update reject duplicates; builtins always win in the merge.

## 10. Self-review
- No placeholders; types concrete; consistent with the loop-runtime spec (`LoopDef`, `Goal`, `Trigger`, `Bounds`, `LoopStateStore`).
- Scope bounded: Telegram-create, agent/MCP-create, and edit-history are explicit non-goals reusing this data layer.
- Governance restated (admin gate, `/home` fence, auto-deny escalations, read-only judge).
