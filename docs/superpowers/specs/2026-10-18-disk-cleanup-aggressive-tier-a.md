# Disk cleanup: an aggressive automatic tier (ADR-0041)

Operator order, 2026-10-18: the dev host has no important files; remove everything big that can be
rebuilt, every day. Extends the ADR-0040 kit (`tools/disk/cleanup.ts`). One seam stays:
`runCleanup(deps)` over an injected shell; each new rule is a pure picker with its own test.

## Tier A gains (automatic)

| Rule | Picker | Acts with |
|---|---|---|
| Unused rebuildable volumes: anonymous (64-hex), or name matches `rebuildableVolumePattern` (caches, go mod/build, buildkit state, node_modules, `test`) | `pickUnusedVolumes` | `docker volume rm` (no force) |
| Mounted cache volumes over `cacheVolumeMaxBytes` (name matches `cacheVolumePattern`), local driver, no DB/protected/skipped container mounts it | `pickCacheWipes` | stop the running users → empty the mountpoint → start them again (always, in `finally`) |
| Container json logs over `containerLogMaxBytes` | `pickLogTruncations` | `truncate -s 0 <LogPath>` |
| Core dumps older than `coredumpMaxAgeHours` | `coredumpVictims` | delete |
| Build outputs (`buildOutputNames`) in a project with no live dev server; git-ignored, no tracked file | `pickBuildOutputs` | delete |
| Test artifacts (`artifactNames`) older than `minAgeDays`, any project; git-ignored, no tracked file | `pickBuildOutputs` | delete |
| Clean worktrees: no change, HEAD on another ref, no process inside, last commit older than `minAgeDays` | `pickWorktrees` | `git worktree remove` (no force) |
| Build cache unused for `buildCacheMaxAgeHours` | — | `docker builder prune -af --filter until=…` |
| Unused images older than `imageMinAgeDays` | `pickImages` | `docker rmi` |
| Old empty `/tmp` folders | `tmpVictims` | delete |
| Go module cache | `packageCaches` | `go clean -modcache` |

**Live project**: `/home/<p>` that a running container bind-mounts (any path under it) or where a
host process has its working folder.

## Tier B (ask first) keeps only

Real DB data (named unused volumes that match no rebuildable pattern; data folders of stopped DB
containers), dumps and backups, and worktrees with work in them (dirty, unpushed, or in use).
`build-output` leaves Tier B.

## Goal

Daily run once in the daily hour (04:00), whatever the disk use; outside it, a run when use is at
or above `alertPct` (80%), unless a run in the cooldown freed less than the floor.

## Edge cases

- A container that fails to start again is reported by name; the run does not stop.
- A cache volume that a DB or protected container mounts is never wiped.
- A non-local volume driver is never wiped (no mountpoint to empty).
- Not a git repo, or `git` fails: the build output is not touched.
- `--dry-run` lists every action and runs none (no stop, no wipe, no truncate).
- Docker `log-opts` in `daemon.json` apply only to containers created after it; truncation covers
  the older ones.

## Acceptance

`bunx tsc --noEmit` and `bun test` green; kit reinstalled to `~/.local/share/neo/disk/`; a real run
frees the approved categories.
