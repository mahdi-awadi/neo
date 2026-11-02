// Fixture for test-temp-root.test.ts: run as its own `bun test` process. It makes a temp folder the
// way Neo's tests do (and never removes it), then prints the path so the parent can check it is gone.
import { test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("leaks a temp folder on purpose", () => {
  console.log(`LEAKED=${mkdtempSync(join(tmpdir(), "neo-leak-"))}`);
});
