---
description: Run the security kit's deep scan on this branch, triage what it finds, then the built-in /security-review
argument-hint: "[commit range, default: upstream..HEAD]"
---
Check the security of this branch's changes in two passes (ADR-0024 in /home/neo).

1. **Scanners.** From the repo root, run
   `bash ~/.claude/security/scan.sh push "$(git rev-parse --show-toplevel)" $ARGUMENTS`.
   It scans the changed files, the commit range for secrets, the dependencies, the Dockerfiles, and
   runs the project's security tests (`testCmd` in `.security/config.json`). It can take minutes and
   prints nothing until it ends, so start it in the background
   (`nohup … > /tmp/neo-security-scan.log 2>&1 &`) and check the log in steps of under 90 seconds.
   If the kit is not installed, say so and go to step 3.
2. **Triage.** For each NEW high or critical finding in the newest
   `.security/reports/push-*.json`, read the code and decide: real and reachable, or a false
   positive (say why). Fix the real ones now, then run the scan again. A medium finding tagged
   `unreachable` is a Go vulnerability osv's call analysis found never called (ADR-0066): list it,
   it does not block. Never edit
   `.security/baseline.json` and never use `--no-verify` to get past a finding.
3. **Review.** Run the built-in `/security-review` on the same changes for what scanners cannot see:
   broken access control, auth and session logic, IDOR, business-logic abuse, unsafe trust in
   client data.

Report in a few lines: what you fixed, what is left (severity, file:line, why), and any false
positive with its reason. Never copy a secret's value into the report.
