---
id: security-kit
kind: cli
status: active
owner: neo
when: "Use before you finish auth, payment, upload or input-handling work, or when a commit or push is blocked by a finding. The kit scans each edit, commit and push, and runs a nightly sweep."
scope: all
env: []
cost: "free (host, scanners run in Docker)"
limits: "only NEW high or critical findings block; a scan can take minutes"
dataLeavesHost: false
tags: [security, scan, semgrep, gitleaks, secrets, vulnerability, commit, push, baseline]
examples:
  - "run the security scan on this branch before I push"
  - "a commit was blocked by a critical finding, what do I do"
  - "enable the security checks in a new repo"
usage:
  commands: ["*tools/security/*", "*security/scan.sh*", "*security/init.ts*"]
---
## How to call

- Deep scan of a branch: use the `/security-scan` skill, or run `bash ~/.claude/security/scan.sh push "$(git rev-parse --show-toplevel)"` (start it in the background; it prints nothing until it ends).
- Turn it on for a repo: `bun ~/.claude/security/init.ts <repo>`.
- The layers are: after each edit, pre-commit, pre-push and the nightly `security-sweep` loop.
- A NEW high or critical finding blocks. Fix the code. If you can show a finding is a false positive, say why and let the operator decide.

Reference: `docs/security-checks.md` (ADR-0024).

## When NOT to use

- Never use `--no-verify`, never edit `.security/baseline.json`, never turn a hook off to get past a finding.
- Do not paste a secret value into a report or a commit message.
- The kit does not replace a design review of access control; run `/security-review` as well.
