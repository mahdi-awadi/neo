import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveInbound } from "../src/engine/files";

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
