import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveInbound, withAttachments } from "../src/engine/files";

test("saveInbound writes under inbox/, sanitizes the name, returns the path", () => {
  const folder = mkdtempSync(join(tmpdir(), "neo-files-"));
  const p = saveInbound(folder, "../../etc/pa ss.txt", new TextEncoder().encode("hi"));
  expect(p).toBe(join(folder, "inbox", "pa_ss.txt"));
  expect(readFileSync(p, "utf8")).toBe("hi");
});

test("saveInbound dedupes a colliding name", () => {
  const folder = mkdtempSync(join(tmpdir(), "neo-files-"));
  const a = saveInbound(folder, "doc.pdf", new Uint8Array([1]));
  const b = saveInbound(folder, "doc.pdf", new Uint8Array([2]));
  expect(a).toBe(join(folder, "inbox", "doc.pdf"));
  expect(b).toBe(join(folder, "inbox", "doc-2.pdf"));
});

// ADR-0026: the one format for a message and its files (console and Telegram).
test("withAttachments: the text, a blank line, then an Attached files list with every path", () => {
  const files = [
    { name: "shot.png", path: "/p/inbox/shot.png" },
    { name: "spec.pdf", path: "/p/inbox/spec.pdf" },
  ];
  expect(withAttachments("use these", files)).toBe(
    "use these\n\nAttached files:\n- `shot.png` at `/p/inbox/shot.png`\n- `spec.pdf` at `/p/inbox/spec.pdf`",
  );
});

test("withAttachments: files with no text are just the list; no files leave the text as it is", () => {
  expect(withAttachments("  \n", [{ name: "a.txt", path: "/p/inbox/a.txt" }])).toBe("Attached files:\n- `a.txt` at `/p/inbox/a.txt`");
  expect(withAttachments("hello", [])).toBe("hello");
});

test("one format on both surfaces: Telegram's caption + file and the console both build with withAttachments", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
  for (const p of ["src/frontends/telegram.ts", "src/engine/web-channel.ts"]) {
    expect(src(p)).toContain("withAttachments(");
    expect(src(p)).not.toContain("operator attached");
  }
  expect(src("src/frontends/web.ts")).not.toContain("operator attached");
});
