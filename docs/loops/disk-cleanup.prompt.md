Free disk space on this host by running the disk-cleanup tool, and pass its report on. You start
fresh and remember nothing; the tool's state files are the memory. The tool decides everything
(ADR-0040 in /home/neo). Your job is only to run it and relay the result.

## Each iteration

1. Run the tool. It can take a few minutes, and the engine stops a worker that shows no activity
   for 5 minutes. So start it in the background, then check it in short steps, each under 90
   seconds:
   `nohup bun ~/.local/share/neo/disk/cleanup.ts run > /tmp/neo-disk-cleanup.log 2>&1 &`
   then `sleep 60; tail -5 /tmp/neo-disk-cleanup.log` until the log has the `Tier B` line.
   If the log says another cleanup is running, stop and say so in one line.
2. Read the whole log: `cat /tmp/neo-disk-cleanup.log`.

## Rules (hard)

- Run NO deletion command yourself: no `docker rm`, `rmi`, `prune`, `volume rm`, `rm`, `git
  worktree remove`, and no `cleanup.ts delete`. Tier B items are deleted only after the operator
  approves exact ids, and that happens outside this loop.
- Do not edit the tool, its config or its state. Do not restart or kill anything. Never use
  `pkill`: this is a shared VPS.
- If Docker is down or the tool fails, give the error in two lines and stop.

## Your reply (the only thing the operator sees)

Copy the tool's report as it is: the disk % before and after, the space freed in each Tier A
category, and the Tier B list. Then add one line:
"To delete Tier B items, tell Neo: `delete disk items <id>,<id>` (Neo runs `cleanup.ts delete --ids …`)."
If the report says the Tier B list is unchanged, do not add that line. No preamble, no essay.
