# Trust defaults on for new projects, and never lifts the fence

**Status:** accepted (2026-10-02)

The operator wants `/trust` on by default for new projects. Projects that already exist must keep
their current setting. An explicit "untrusted" must stay untrusted.

The trust store could not support this. It was presence-only (`src/engine/trust.ts`): a row meant
trusted, and `/trust off` deleted the row. So "the operator set this off" and "never seen" were the
same state. A default for "no row" would have silently trusted every project the operator had
turned off, and every existing project that was never trusted.

Trust also approved *every* escalation, including a Write/Edit outside the project folder
(`governor.ts`). With trust off by default this was a narrow, per-folder operator choice. With trust
on by default it would remove the path fence for almost every project — the hard firewall would move.

## Decision

1. **A trust record is explicit.** The `trust` table keeps its old meaning: a row means trusted. A
   new `trust_untrusted` table records "untrusted". `/trust off` moves the folder from one table to
   the other. Folder keys are normalised (`path.resolve`), so `/home/x/` and `/home/x` are one record.

2. **Existing projects are frozen at their current setting.** The migration runs once (SQLite
   `user_version` 0 → 2). It records every folder the ledger already knows (`orders`,
   `open_sessions`) with no `trust` row as untrusted. These projects were untrusted before, and
   they stay untrusted when the default turns on.

3. **The default is recorded at first sight.** When `isTrusted(folder)` finds no record, it stores
   `trust.defaultForNewProjects` for that folder and returns it. So the default belongs to the
   moment a project is first seen. Changing the knob later does not change projects that already
   exist. The knob is config (`loadConfig`), off in code, on in the operator's `config.json`.

4. **Trust never lifts a fence escalation.** An out-of-folder file write is an escalation with
   `fenced: true`. `canUseTool` never approves it automatically: the operator approves it, or an
   autonomous path denies it. This applies to every trusted folder, old and new.

5. **Trust never applies to customer-sourced work.** `canUseTool` ignores `autoApprove` when the
   order's source is `customer`. This adds a second guard on top of the router refusal and
   `denyAllTrust()`, at the one seam every Claude launch goes through.

## Rejected

- **A `trusted` column on the `trust` table.** It is one table, but the old code reads any `trust`
  row as trusted. A rollback would then trust every frozen project and every `/trust off`, and
  that code also has no fence. Two tables keep a rollback failing closed.
- **Resolve the default at read time and record nothing.** It is simpler, but changing the knob
  would then change the trust of every project without a record, after the fact. "Default for new
  projects" means the value is set when the project is first seen.
- **A separate `ensureSeen(folder)` call at each launch site.** The pipeline, dispatch and loops
  each create sessions. Any site that forgot the call would leave a project with no record, and
  every later read would give the wrong default. The store is the one place every trust read goes
  through.
- **Keep trust lifting the fence and document it.** With trust on by default, the path fence would
  stop applying to almost every project. The firewall is code, not a setting that a default can
  turn off.

## Consequences

- An out-of-folder Write/Edit in a trusted project now asks the operator. Before this, it was
  approved automatically. Risky Bash, WebFetch and foreign MCP tools are still approved
  automatically in trusted folders.
- The fence covers the file-write tools only. A Bash command can still write outside the folder
  (`RISKY_BASH` is defense in depth, not a fence). This is unchanged and is out of scope here.
- Going live needs a daemon restart. The migration runs on the first start of the new code.
