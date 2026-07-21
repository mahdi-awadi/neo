import { test, expect } from "bun:test";
import { consolePage } from "../src/frontends/web";

// The console page embeds a large inline <script>. Neither tsc nor bun test parses that
// served JS, so a syntax error in it ships silently and breaks the ENTIRE console (one
// SyntaxError halts all inline script). A classic trap: a backslash-escaped quote like
// `\'` written inside the TS backtick template literal — the template parser consumes the
// backslash, so the served JS loses the escaping and emits adjacent string literals.
// This guard parses the served script and fails on any such syntax error.
test("consolePage inline <script> parses as valid JavaScript", () => {
  const html = consolePage();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(m).toBeTruthy();
  const body = m![1];
  expect(body.length).toBeGreaterThan(0);
  // new Function compiles (parses) the body without executing it — throws SyntaxError if invalid.
  expect(() => new Function(body)).not.toThrow();
});

test("consolePage's stream handler renders mirrored echo + notice events", () => {
  const html = consolePage();
  const body = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  // The operator's own message mirrored from Telegram → a `me` row (same style as locally-typed).
  expect(body).toContain("e.type==='echo'");
  // Cross-surface chrome (e.g. approval pending on Telegram) → a display-only notice row.
  expect(body).toContain("e.type==='notice'");
});
