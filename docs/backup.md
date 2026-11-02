# Snapshot backup — runbook (ADR-0067 Decision 8)

Neo takes a snapshot backup of its SQLite files. By default, only `data/history.db` is in the list. That
file holds two things that exist nowhere else: archived history entries and remembered entries. The
ledger joins the list only by the operator's decision (ADR-0067, "Separate operator decision: the ledger
backup").

Config: the `backup` section (`docs/CONFIG.md`, "Snapshot backup"). Code: `src/engine/backup/`.

## What the job does

The daemon's heartbeat step `backup` starts a child process when a cron slot comes:

1. `bun src/engine/backup/run.ts --source <db> --dir <folder> …` (each path is its own argument; no shell).
2. The child checks the free space in the folder (`minFreeGb`).
3. It opens the database read-only and runs `VACUUM INTO` a temp file. Writers can continue.
4. It runs `PRAGMA integrity_check` on the copy and reads the row counts and `user_version`.
5. It compresses the copy, syncs it to disk and renames it to `<name>-<UTC yyyymmddThhmmssZ>.db.gz`.
6. It writes the manifest `<name>-<stamp>.manifest.json`: SHA-256, sizes, row counts, duration.
7. It deletes old snapshots of the same database (the rotation). It never deletes other files.

Rotation keeps the newest 8, then the newest of each day for 7 more days, then the newest of each ISO
week for 4 more weeks.

Each Sunday (`drillCron`), the restore drill runs as a child too. It takes the newest snapshot of each
database, checks its SHA-256, restores it to a temp file, runs `integrity_check`, compares the row counts
with the manifest and deletes the temp file.

The folder is `/var/backups/neo` (mode 0700). Files are mode 0600. The disk-cleanup kit protects the
folder (`tools/disk/defaults.json`).

The folder must be used only for these backups. When it does not exist, the child makes it with mode
0700. When it exists and holds only snapshots, manifests and the job's temp files, the child sets it to
mode 0700. When it holds any other file, the child refuses (`dir_not_dedicated`) and does not change the
folder: set `backup.dir` to a folder of its own.

Before each child starts, the schedule deletes the temp files that a killed child of the same job left
(`.<name>-….tmp`, `<name>-<stamp>.manifest.json.tmp`, and `.drill-….tmp` for the drill). Only one child
runs at a time, so no running child uses them.

## When a backup fails

You get one alert for each failure streak, and the `backup_failed` attention item stays until the next
success. The ledger has a `backup_failed` event with the code for each failure.

| Code | Meaning | What to do |
| --- | --- | --- |
| `low_space` | Less than `minFreeGb` free in the folder. | Free disk space (the disk-cleanup loop), or lower `minFreeGb`. |
| `dir_not_dedicated` | The backup folder holds files that are not backups. | Set `backup.dir` to an empty folder of its own (or move the other files out). |
| `source_missing` | The database file does not exist. | Check the path in `backup.databases`. |
| `copy_failed` | `VACUUM INTO` failed. | Read the alert text. Check the folder permissions and the disk. |
| `integrity_failed` | The copy is corrupt. | The source may be corrupt. Run `PRAGMA integrity_check` on a copy of it. Do not delete old snapshots. |
| `compress_failed` | Gzip failed. | Check the disk. |
| `timeout` | The child ran longer than `timeoutMs`. | Check the disk speed and the database size. Raise `timeoutMs` if needed. |
| `checksum_mismatch`, `count_mismatch`, `restore_failed`, `no_snapshot`, `manifest_unreadable` | The drill failed. | The newest snapshot is not good. Do not delete the older snapshots. Run a snapshot by hand (below) and then the drill. |
| `spawn_failed`, `child_failed`, `bad_args`, `error` | The child did not start, ended with no known code, got wrong arguments, or failed in another way. | Read the alert text. Run the same command by hand (below) and read its output. |

To list the snapshots:

```sh
ls -l /var/backups/neo
```

To run a snapshot by hand (the same command the daemon runs):

```sh
bun src/engine/backup/run.ts --source /home/neo/data/history.db --dir /var/backups/neo --name history \
  --compress 1 --min-free-gb 20 --keep 8,7,4
```

To run the drill by hand:

```sh
bun src/engine/backup/drill.ts --dir /var/backups/neo --names history
```

## Restore `history.db`

Do these steps in this sequence. The daemon restart is the operator's.

1. Stop the daemon (operator).
2. Move the old file and its `-wal` and `-shm` files aside. Do not delete them:

   ```sh
   cd /home/neo/data
   stamp=$(date -u +%Y%m%dT%H%M%SZ)
   for f in history.db history.db-wal history.db-shm; do [ -e "$f" ] && mv "$f" "$f.before-restore-$stamp"; done
   ```

   If you keep an old `-wal` file next to the restored file, SQLite can apply it to the wrong database.

3. Choose a snapshot (the newest one that passed the drill) and check it against its manifest:

   ```sh
   snap=/var/backups/neo/history-<stamp>.db.gz
   sha256sum "$snap"          # must equal "sha256" in history-<stamp>.manifest.json
   ```

4. Restore it with mode 0600:

   ```sh
   gunzip -c "$snap" > /home/neo/data/history.db
   chmod 600 /home/neo/data/history.db
   sqlite3 /home/neo/data/history.db 'PRAGMA integrity_check;'   # must print: ok
   ```

5. Start the daemon (operator). The indexer continues from the cursor in the restored file. Ledger rows
   that changed after the snapshot come back through the change feed or the next reconcile. Entries that
   were remembered or archived after the snapshot are lost.

6. Do the forgets again. A restore also undoes each `forget` made after the snapshot: the restored file
   has no tombstone for it, so the reconcile adds the entry again. Find the forgets in the ledger (the
   `history_forget` events after the snapshot time give the refs, while retention still keeps those events)
   and run each one again:

   ```sh
   bun tools/history/admin.ts forget <ref> --reason "<the reason again>"
   ```

   For `rescan-secrets` forgets, run `bun tools/history/admin.ts rescan-secrets` instead.

If the daemon finds a corrupt `history.db` at start, it moves the file to
`history.db.corrupt-<UTC time>` by itself and sends one alert. Then do steps 3 to 5.

## Off-host copies

This job keeps its copies on the same host. An off-host copy is a separate decision (ADR-0067). Ops lists
`/var/backups/neo` in the backup inventory.
