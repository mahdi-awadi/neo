# Proposal: security rules for the two CLAUDE.md files

**Status:** proposal only. Nothing has been written to either file. The operator decides.
Context: the shift-left security kit (ADR-0024, `tools/security/`).

## Why both files

- `~/.claude/CLAUDE.md` is loaded by **every** Claude Code session on this host: your own sessions,
  and every Neo worker in every project. So the rules that must hold everywhere go here.
- `/home/neo/CLAUDE.md` is loaded only by sessions in the Neo repo. It records why the rules exist and
  where the kit lives, as it does for the engineering baseline.

Workers get the same rules a third way: one short REQUIRED line in the dispatch preamble
(committed, `briefWithProjectDocs`).

## Diff 1: `~/.claude/CLAUDE.md` (server-wide)

```diff
 # Server-wide agent rules (all Claude Code sessions and neo workers on this host)

 - State only what you verified. A memory note is a lead to check, not a fact.
+
+## Security rules
+
+- A security scan runs when you edit a file, commit, and push. A NEW high or critical finding
+  blocks. Fix the code. Never use `--no-verify`, edit `.security/baseline.json`, or turn a hook off.
+  If you can show a finding is a false positive, say why and let the operator decide.
+- Never read, print or paste a secret file (`.env`, keys, credential files). Read config through the
+  app's env loader. A secret never goes into code, a log, a commit or a reply.
+- Treat all input as hostile. Use parameterized queries, never string-built SQL, shell or HTML.
+  Check authorization on the server for every object you return (no IDOR).
+- Before you finish auth, payment, upload or input-handling work, run `/security-scan` (or the
+  built-in `/security-review`) on your changes.
```

## Diff 2: `/home/neo/CLAUDE.md` (this repo)

Inserted after the "Engineering baseline" section, before "Conventions":

```diff
 Every dispatched worker gets this automatically: the dispatch preamble (`briefWithProjectDocs` in
 `src/engine/dispatch.ts`) carries it, because a worker sent into another folder loads *that*
 project's CLAUDE.md, never this one. Don't re-type it into briefs.
+
+## Security checks (ADR-0024)
+
+The kit in `tools/security/` scans at four layers: each edited file (Claude Code hook), pre-commit,
+pre-push, and a nightly sweep (`docs/loops/security-sweep.json`). Only NEW high or critical findings
+block; a project's existing findings are its baseline (`.security/baseline.json`). Every scanner
+runs in a digest-pinned Docker image; a missing Docker only warns.
+
+- Install for all sessions: `bun tools/security/install.ts`. Turn on for a repo:
+  `bun ~/.claude/security/init.ts <repo>`. Full reference: `docs/security-checks.md`.
+- The rules for every session live in `~/.claude/CLAUDE.md` and, for workers, in the dispatch
+  preamble. Don't re-type them into briefs.

 ## Conventions
```

## Options

1. **Apply both** (recommended): the server-wide rules reach every session, including the operator's
   own, and the repo file explains the kit.
2. **Apply the repo file only:** workers still get the rules from the preamble; the operator's own
   sessions in other repos do not.
3. **Apply neither:** workers still get the preamble line.
