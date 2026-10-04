# Trust never lifts the fence; one trust store

**Status:** accepted (2026-10-04)

Two branches built "new projects start trusted" at the same time. `207aed4`
(`fix/telegram-flood-control`) adds a `state` column (`on`/`off`) to the trust store and seeds a
never-seen folder at session start (`trustNewProjects`). `4b7848c` (`feat/trust-default-new-projects`)
keeps "a row means trusted", records untrusted folders in a second table, and also hardens the
governor: an out-of-folder Write/Edit becomes a **fence escalation** that trust never approves, and
trust never applies to a customer-sourced order.

The live daemon ran `207aed4`, so `data/trust.db` is already at its schema (`user_version` 1, eight
folders `off`).

## Decision

1. **Keep `207aed4`'s store.** It is what the live data uses.
2. **Port `4b7848c`'s firewall part.** `decide` marks an out-of-folder write `fenced: true`;
   `buildCanUseTool` takes the order's source and auto-approves only when the verdict is not
   fenced and the source is not `customer`. `/trust on` says that writes outside the folder still ask.

## Considered options

- **Adopt `4b7848c`'s store instead.** Rejected. Its read is "a row in `trust` means trusted". On the
  live `trust.db`, the eight `off` rows are rows in `trust`, so its migration would turn eight
  folders the operator (or the migration) turned off into trusted folders: the store would fail
  open. It would need a data migration for no added behaviour.
- **Keep both.** Rejected: two implementations of one rule.
