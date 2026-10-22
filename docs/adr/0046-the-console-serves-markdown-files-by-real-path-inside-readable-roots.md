# The console serves Markdown files by real path inside readable roots

**Status:** accepted (2026-10-22). Related: ADR-0017 (console), ADR-0024/0030 (secret names),
ADR-0026 (attachments).

Workers often end a reply with the path of a Markdown file they wrote (a note, a plan, a report),
for example `/home/learning/notes/how-neo-works.md`. The operator reads the console on a phone and
cannot open that path. The host is public, so an endpoint that reads a file by path is an
arbitrary-file-read risk.

## Decision

1. **One server seam.** `resolveMdFile(path, cfg)` in `src/engine/md-file.ts` decides and reads.
   It returns the file's bytes and a safe name, or a refusal with an HTTP status. The web route
   `GET /md-file?path=…` only adds the session check, the headers and the ledger event.
2. **The rules, in order.** The path must be absolute, without NUL, `.` or `..` segments, and
   without a hidden segment (`.git`, `.env*`, `.claude`, `.ssh` …). The name must end in `.md`
   (any case). No segment may be a secret name by the security kit's rule (`isSecretName` from
   `tools/security/guard.ts`, reused, not copied). Then `realpath` resolves it, and the **same
   rules run again on the real path**, which must also be inside the real path of a readable root
   (`mdFiles.roots`, default `[workRoot]`). A symlink that leaves the roots, or points to a
   hidden or non-`.md` file, is refused.
3. **Read through one file descriptor.** The file is opened with `O_NOFOLLOW`, then `fstat` on the
   descriptor checks "regular file" and the size cap (`mdFiles.maxBytes`, default 2 MiB). The bytes
   that are sent are the bytes of the file that was checked.
4. **The response** is `text/markdown; charset=utf-8`, `Content-Disposition: attachment` with an
   ASCII `filename` and an RFC 5987 `filename*`, `X-Content-Type-Options: nosniff`,
   `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: no-store`.
5. **Auth** is the console's admin session cookie, like `/file`. The route is a GET with no side
   effect except the audit event, the cookie is `SameSite=Lax`, and a cross-site page cannot read
   the response (no CORS headers, CORP same-origin). So no CSRF token is needed.
6. **Audit.** Every request with a session writes the ledger event `md_file` with the asked path,
   the real path when there is one, the outcome and the session (the admin's user id and a short
   hash of the session token, never the token).
7. **The browser** links a path only when it looks like one the server can serve (absolute, ends
   in `.md`, no hidden or `..` segment). `md-links.ts` holds the pure detector and the DOM pass. It
   runs on every rendered feed row, thread and card, next to the code-block enhancer, and skips
   code blocks, links and buttons. The link is `dir="ltr"`, so the path stays LTR in Arabic text.

## Rejected alternatives

- **Link the path in the server Markdown renderer (`format.ts`).** It would miss the operator's
  own lines, which the browser renders (`text-lines.ts`), and Telegram shares that renderer, where
  a console URL means nothing.
- **Serve any text file, or a list of extensions.** The order is Markdown only. Every extra type
  is more risk for no need.
- **Check the path as written, without `realpath`.** A symlink inside a root could then point
  anywhere on the host.
- **A preview pane with the rendered Markdown.** Optional in the order. It needs a second response
  shape and a rendered view. Kept out to stay simple: the operator's phone opens the downloaded
  file.
- **A signed one-shot token per link (like staged attachments).** The paths come from worker text,
  not from the engine, so there is nothing to sign at render time. The session check and the path
  rules are the boundary.
