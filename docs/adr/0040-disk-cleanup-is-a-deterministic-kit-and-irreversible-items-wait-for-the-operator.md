# Disk cleanup is a deterministic kit, and irreversible items wait for the operator

**Status:** accepted (2026-10-17).

The dev host kept sending low-disk warnings. On 2026-10-17 `/` was 92% full (364G of 399G). Docker
held most of it: build cache 51.5G, images 89G, volumes 154G (271 of them unused). The operator
ordered a recurring cleanup loop with two tiers. Tier A is removed automatically, because it can be
rebuilt. Tier B is only reported, because removing it cannot be undone.

## Decision

1. **The cleanup is code, not a worker's judgement.** `tools/disk/cleanup.ts` decides and acts.
   Its decisions are pure, tested functions over an inventory. The shell is injected, so tests
   never touch the host. A loop worker only runs the tool and passes its report on. An AI never
   chooses what to delete.
2. **Tier A (automatic):**
   - dangling images;
   - images that no container uses (running or stopped) and that are older than 7 days;
   - build cache older than 7 days;
   - containers that stopped more than 7 days ago (`docker rm` without `-v`, so their volumes stay);
   - `journalctl --vacuum-size`;
   - rotated or compressed files under `/var/log`;
   - the bun, npm, go-build and pip caches;
   - `/tmp` files whose atime, mtime and ctime are all older than 7 days (the `systemd-tmpfiles`
     rule), never inside a folder that holds a `.git`.
   The space freed in each category is measured as the change in used bytes on the filesystem.
3. **Tier B (report only):** unused volumes, database data folders, DB dumps and backups, git
   worktrees, and big build outputs (`node_modules`, `.next`, `dist`). Each one gets a stable id
   (a hash of its kind and target), its size, its last-used date and its owning project. `delete
   --ids` removes only the ids the operator approved. It checks each item again first, and it never
   forces: `docker volume rm` refuses a volume in use, and `git worktree remove` refuses a dirty
   tree.
4. **Never touched, in either tier:**
   - a running container or its volumes;
   - anything whose name, path, tag or compose project matches a protect pattern: `prod`,
     `/home/neo/data`, `/home/neo/company`;
   - `.env` files;
   - the security kit's pinned scanner images (from its `images.env`), which the nightly sweep
     needs.
   Values live in `tools/disk/defaults.json`. A host can override them in `config.json` next to the
   installed kit.
5. **It is installed like the security kit**, to `~/.local/share/neo/disk/`. The loop runs that
   copy, so it does not depend on which branch the live checkout is on.
6. **The loop:** a 60-minute interval with a command goal. `cleanup.ts check` passes, with no worker run
   and no cost, when one of these is true:
   - use is under the target (70%);
   - outside the daily hour, use is under the alert level (80%);
   - a clean in the last 6 hours freed less than 1 GB, so nothing safe is left.
   That gives "daily, plus whenever the disk is over 80%" on a runtime that has only manual,
   interval and cron triggers. It is an interval, not the cron `0 * * * *`. The scheduler skips a
   loop while its folder is busy, and `/home/neo` often is. A cron fire skipped at minute 0 is lost
   for the hour. A skipped interval fire records no run, so it starts at the first free tick. The
   daily run is then the first fire in the daily hour; if the folder is busy all that hour, the
   day's 70% run is skipped, and the 80% rule still applies.

## Considered options

- **Let the loop worker run the docker and rm commands from a prompt.** Rejected. A model would
  then decide what is "safe" on a shared VPS with production containers on it. The tiers are a
  hard rule, so they belong in tested code.
- **`docker system prune -a --volumes`, or `docker image prune -a`.** Rejected. The first deletes
  volumes, which is Tier B. Both ignore the prod and scanner-image exclusions, and
  `container prune --filter until` ages a container by when it was created, not when it stopped.
- **`ask_operator` from the loop worker.** Not possible today: the loop path attaches no Neo MCP
  tools (`loopRunExtras` in `src/engine/loops.ts`), and scheduled escalations are auto-denied. Until
  the engine gives loops `ask_operator`, the loop prints the Tier B list with ids in its reply,
  which reaches the operator's chat. An operator session, or Neo's main session, raises the
  decision and runs `delete --ids` with the approved ids. Wiring `ask_operator` into loops is a
  separate, restart-gated engine change.
- **A new engine trigger kind (disk threshold).** Rejected for now. The free goal check before
  each fire gives the same behaviour without an engine change or a restart.

## Consequences

- The cleanup is safe to run at any time and twice in a row. A second run frees about nothing.
- Over-protection is by design: the `prod` pattern also keeps anything named "product". That errs
  toward keeping.
- The Tier B list repeats every day while its items exist. When nothing has changed, the report
  shows only a one-line total. The full list stays in `state/candidates.json`.
