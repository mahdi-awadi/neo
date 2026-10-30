# A disk guard in the heartbeat runs Tier A under pressure and alerts before the disk is full

**Status:** accepted (2026-10-30, built on dev, restart-gated). Amends ADR-0040 and ADR-0041 (who runs
Tier A). Related: note #555.

## Context

On 2026-10-30 at about 08:05 UTC the dev host root disk (`/dev/sda4`, 399 GB) reached 100 % with 30 MB
free. eticket's builds and tests failed with "no space left on device". The disk-cleanup kit (ADR-0040,
ADR-0041) exists and works: its last run, on 2026-10-28 at 06:10 UTC, took the disk from 90.1 % to
58.5 % and freed 136 GB. It did not run again.

Root cause (checked in the ledger and the code):

- Tier A ran **only** through the `disk-cleanup` loop: an AI worker session in `/home/neo`, fired by the
  loop scheduler every 60 minutes with the goal command `cleanup.ts check`.
- `tickScheduler` skips a loop whose folder is busy (`isFolderBusy(def.folder)`), and `/home/neo` — Neo's
  own repo — is busy almost all the time (worker sessions, builds). The loop's `last_run` was
  2026-10-29 12:46 UTC; the goal check then saw the disk under 80 % and ran nothing. From then on every
  tick found the folder busy, including the 04:00 daily run, while the disk went from about 58 % to
  100 % (about 166 GB in 50 hours, an average of 3.3 GB per hour).
- The build-cache policy was not the cause: Tier A already prunes the build cache to 10 GB
  (`docker builder prune -af --max-used-space 10gb`), and the host has only the `default` builder.
  The cache reached 65 GB only because Tier A did not run.
- There was no alert: the 80 % level was only a loop goal, never a message to the operator.

## Decision

1. **A disk guard in the daemon's heartbeat** (`src/engine/disk-guard.ts`, `disk-guard-runtime.ts`),
   plain code, no AI session, once per heartbeat tick (at most 60 s). Each tick it samples the disk use
   and decides:
   - **Pressure:** free space below `pressureFreePct` (10 %) starts the kit's Tier A run at once
     (`bun <kit>/cleanup.ts run`), with a `pressureCooldownMinutes` (30) cooldown.
   - **Daily:** the daily Tier A run starts in `dailyHour` once a day, whatever the use.
   - **Alerts:** a Telegram alert (the existing operator-alert path, the Decisions channel) when the use
     crosses each step in `alertStepsPct` (80, 90, 95 %), repeated every `alertRepeatMinutes` (120)
     while it stays there. The alert names the use, the free space and the hours until full, from a
     least-squares fill rate over the last `sampleKeepHours` (6). When a run the guard started has
     finished, the guard reports what it freed.
2. **The kit stays the one implementation.** The guard runs the kit's own `run` (Tier A only, its own
   lock, its own report in `state/last-run.json`); it never deletes anything itself and never touches
   Tier B. The run starts in its own systemd unit (`systemd-run --unit=neo-disk-tier-a --collect`, an
   argv, no shell): its own cgroup, so a daemon restart (`KillMode=mixed`) does not kill it in the middle
   of a cache-volume wipe; one instance at a time; its output in the journal. Without systemd-run it falls
   back to a detached child. A live lock holder means the guard starts nothing, and the kit now takes its
   lock atomically (`wx`).
6. **It never spins and never floods.** A pressure run follows the kit's own back-off: after a run that
   freed less than `nothingLeftBytes`, no pressure run for `cooldownHours`. The kit's last run by anyone
   (the loop, the operator) counts for the pressure cooldown and the daily slot; a daily run missed while
   the daemon was down catches up later the same day. An alert step clears only `alertHysteresisPct`
   below the first step and repeats only while the use still rises. A run with no result after
   `pendingTimeoutMinutes` is reported as failed. When the kit cannot be read, the guard still alerts from
   the defaults and starts no run; the failure is one event, not one per tick. The state keeps an
   in-memory copy, so a full disk that refuses the ledger write cannot turn every tick into an alert. The
   fill rate ignores the drop a cleanup makes. The disk use comes from `statfs` (no child process).
3. **The kit's config is the one source of thresholds.** The new keys live in `tools/disk/defaults.json`
   next to `alertPct` and `dailyHour`; the guard reads the installed kit's config every tick, so an edit
   applies without a restart. A key that is missing (a kit installed before this) or broken falls back
   to the same defaults (a test keeps them equal), so a bad edit never turns the guard off.
4. **Neo config:** only `diskGuard.enabled` (default on; `NEO_DISK_GUARD=0` turns it off) and
   `diskGuard.kitDir` (default `~/.local/share/neo/disk`).
5. **The `disk-cleanup` loop stays** for its report and the Tier B list; Tier A no longer depends on it.

## Alternatives rejected

- **Exempt the loop from the busy-folder skip, or give it its own folder.** Tier A would still wait for
  an AI session, a budget and a free slot. A safety guard must be deterministic and cheap.
- **A systemd timer next to the daemon.** Works without the daemon, but needs a second alert path with
  its own Telegram token, and a second copy of the thresholds. The daemon is always running (the
  sentinel pages when it is not), and its heartbeat already hosts the engine's other periodic steps.
- **A lower `alertPct` for the loop goal.** Same root cause: the goal is only checked when the loop
  fires.
- **A separate build-cache job.** The kit already caps the build cache at 10 GB in Tier A; it only has to
  run.

## Consequences

- Tier A now runs within one minute of the disk passing 90 % used, and the operator is told at 80, 90
  and 95 % with the hours left.
- Restart-gated: the guard starts with the next daemon start. Until then, the loop is the only path.
- Measured on 2026-10-30: one Tier A run freed 95.4 GB (95.3 % → 73.1 %).
