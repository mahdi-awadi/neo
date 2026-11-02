# Security checks run shift-left, in pinned scanner containers

**Status:** accepted (2026-10-08)

Every project gets the same security checks, at four layers, from one kit in `tools/security/`:
the write-time hook (each file a worker edits), pre-commit (staged files), pre-push (the commit
range, dependencies, Dockerfiles, security tests) and a nightly sweep (everything, git history,
images, an SBOM, DAST against dev URLs). Every scanner runs from a digest-pinned Docker image, so
nothing is installed on the host. Only **new** high or critical findings block. A project's
existing findings are recorded once as its **baseline**: they are tracked, never blocking. A
missing Docker or scanner only warns: a scanner outage must never stop editing or committing.

## The write-time scan must be fast

The hook runs after every edit, so its cost is paid many times a turn. The first build took
36.7 s for one file. Measured on `src/frontends/web.ts` (2026-10-08, load ≈ 7 on 8 cores):

| Cost | Seconds |
|---|---|
| `docker run` (container start) | ≈ 2.5 |
| semgrep's Python wrapper start | ≈ 3 |
| 12 registry packs, 1 096 rules, many duplicated or for other languages | ≈ 20 |

So the write-time layer now:

1. **Uses per-language merged rule files**, built when the packs are downloaded
   (`rules.ts build`). Each file holds only the rules for that language, with no duplicate ids.
   `generic.secrets` rules go in one `common` file. For a TS file, 1 096 rules become about 250.
2. **Runs osemgrep** (`semgrep --experimental`, the native CLI). It finds the same results on the
   rule fixtures and starts in 0.8 s, not 3.6 s.
3. **Executes in a warm container.** It is started once, with no network, a read-only root and no
   host mounts except the rules. The files to scan are streamed in with `tar` and removed afterwards.
4. **Runs gitleaks in parallel** in its own warm container.

The deep layers (push, nightly) use the same merged files plus `security-audit`.

## Considered options

- **Install semgrep and gitleaks on the host.** Rejected: the operator rule is that everything runs
  in Docker, and a host install drifts from the pinned version.
- **Mount `/` (or `/home`) into a long-lived container so it can see any repo.** Rejected: it gives a
  scanner image read access to every secret on the host. Streaming the few files to scan costs
  milliseconds.
- **Scan only the custom rules at write time.** Rejected: the OWASP and secrets packs catch what the
  custom rules do not. Merging keeps them and removes only the waste.
- **Semgrep's server mode / LSP.** Rejected: not in the OSS CLI as a stable interface.

## Consequences

- One container per scanner and kit copy (`neo-sec-semgrep-<kit hash>`, `neo-sec-gitleaks-<kit
  hash>`) stays up, idle. It is recreated when the image digest changes. `docker rm -f` it at any
  time: the next scan starts it again.
- Findings name repo-relative paths and rule ids without the config's directory prefix, so a
  baseline gives the same fingerprints in every checkout and worktree.
