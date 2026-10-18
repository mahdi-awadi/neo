# Disk cleanup removes everything rebuildable, daily

**Status:** accepted (2026-10-18). Amends ADR-0040 points 2, 3 and 6.

On 2026-10-18 `/` was 86% full (367 GB of 428 GB). The ADR-0040 kit freed only 12.6 GB, because most
of the space was in places it only listed or did not see: Go build-cache volumes inside running
eticket containers (58 GB), unused cache and test volumes (35 GB), build cache younger than 7 days
(42 GB), core dumps (4 GB), one 934 MB container log. The operator ordered: this dev host holds no
important files; remove everything big that can be rebuilt, and do it every day.

## Decision

1. **Tier A now covers everything rebuildable.** New rules, each a pure picker with tests:
   - unused volumes that are anonymous or whose name says they are rebuildable (caches, Go
     mod/build, buildkit state, `node_modules`, `test`): `docker volume rm`;
   - cache volumes that a container mounts, above a size cap (5 GB): stop the running containers
     that use it, empty the volume's mountpoint, start them again;
   - container json logs above 100 MB: truncate;
   - core dumps older than 24 hours;
   - build outputs (`node_modules`, `.next`, `dist`, `build`, `.dart_tool`, `bin`, `obj`, …) of a
     project with no live dev server, and test artifacts (`coverage`, `test-results`,
     `playwright-report`) older than 7 days in any project;
   - clean worktrees whose HEAD is on another ref, with no process in them, idle 7 days;
   - build cache above 10 GB, least recently used first (`builder prune -a --max-used-space`);
     unused images older than 2 days;
     old empty `/tmp` folders; the Go module cache.
2. **Tier B keeps only what cannot be rebuilt:** named unused volumes that may hold real DB data,
   data folders of stopped DB containers, dumps and backups, and worktrees with work in them.
3. **A build output is touched only if git ignores it and tracks nothing in it.** This is the
   `git clean -X` rule. It makes generic names like `bin` and `build` safe. Outside a git repo the
   rule does not apply and nothing is removed.
4. **A live project** is `/home/<p>` that a running container bind-mounts, or where a host process
   has its working folder. Its build outputs stay, because a dev server is using them.
5. **A wiped cache volume keeps its container.** The tool empties the volume's mountpoint while the
   users are stopped, then starts the same containers. Removing the volume would need the container
   removed and recreated by its compose project, which the tool does not own. DB containers,
   protected containers and the skip list (in-flight buildkit builders, netdata's metrics store)
   are never stopped. A start that fails is reported by name. A wipe keeps the volume's top-level
   `bin/` (`wipeKeep`): a volume mounted as a whole GOPATH holds installed tools there, not cache.
   The first run wiped `mirshad_mirshad_go_cache` (mounted at `/go`), removed `/go/bin/air`, and
   `mirshad-api` could not reinstall it (`air@latest` needs a newer Go than its image).
6. **The loop runs daily at 04:00 whatever the disk use**, and outside that hour when use is at or
   above 80%. `targetPct` is gone. The cooldown floor still stops repeat runs that free nothing.

## Considered options

- **Remove mounted cache volumes (`docker rm` the container, `volume rm`, `compose up`).** Rejected:
  the tool would have to know each compose project's file and env, and a failed `up` leaves a
  service gone instead of stopped.
- **Wipe mounted caches without stopping.** Rejected: a compile in progress reads a vanishing cache
  and fails in odd ways; a stop is clear and short.
- **Keep build outputs in Tier B.** Rejected by the operator: they reinstall on demand.
- **Delete build outputs by name alone.** Rejected: `bin/` and `build/` are often tracked source.
  The git-ignore rule is the standard safe test.
- **Age out build cache (`builder prune --filter until=24h`).** Rejected after a real run: on
  buildx with the containerd image store it freed nothing, even for entries unused for 12 days.
  A size cap with LRU eviction is buildkit's own GC model and freed 26 GB.
- **`docker system prune -a --volumes`.** Still rejected (ADR-0040): it removes named DB volumes and
  ignores prod and the pinned scanner images.

## Consequences

- The first build of each service after a wipe is slow (a cold Go cache). Wiping six eticket
  services at once took the load average to 181 for about 15 minutes. Fresh caches are 0.7–1.8 GB,
  so the 5 GB cap wipes only a bloated cache (one had grown to 31 GB), not every cache every day.
- A CI job that is running when its runner's cache is wiped fails; at 04:00 this is rare.
- Daemon log rotation (`max-size 50m`, `max-file 3`) is already in `daemon.json`, but it applies
  only to containers created after it; the truncation rule covers the older ones.
