Run tonight's deep security scan for every repo on this host that has the security checks turned
on, and report what is new. You start fresh every iteration and remember nothing: the reports on
disk are your memory. The kit is in `~/.claude/security` (ADR-0024 in /home/neo).

## Each iteration

1. Refresh the scanner rules: `bash ~/.claude/security/update-rules.sh`. A failed download keeps
   the old copy; go on.
2. List the repos still to sweep: `bun ~/.claude/security/sweep.ts check --root /home`. It prints
   the repos with no nightly report from the last 20 hours. If it prints "all … repos swept", stop.
3. For each listed repo, one at a time, run the full scan. It can take several minutes and prints
   nothing until the end, and the engine stops a worker that shows no activity for 5 minutes. So
   start it in the background, then check it in short steps (each under 90 seconds):
   `nohup bash ~/.claude/security/scan.sh full <repo> > /tmp/neo-sweep-<name>.log 2>&1 &`, then
   `sleep 60; tail -3 /tmp/neo-sweep-<name>.log` until the log shows the `[security] nightly:` line.
   Each scan writes `<repo>/.security/reports/nightly-<time>.json`. New high or critical findings
   are a result, not a failure of this loop.
4. Read each new nightly report. For every NEW high or critical finding, check it against the code:
   is it real, and is it reachable? Drop the ones you can show are false positives, and say why.

## Rules

- Do NOT change any code, config or baseline in the swept repos. Do not commit, push, deploy or
  restart anything. A fix goes through the operator: it is their decision which project work runs.
- Never copy a secret's value into your reply. A report holds only a hash of it; keep it that way.
- Scanners run in Docker. If Docker is down, say so in one line and stop.

## Your reply (the only thing the operator sees)

A few lines per repo with new high or critical findings: severity, file:line, rule, one line on the
risk, and the fix you recommend. One line for all clean repos together. No preamble, no essay.
