import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { openTrustStore } from "../src/engine/trust";

test("a folder is untrusted by default; setTrust toggles it", () => {
  const t = openTrustStore(":memory:");
  expect(t.isTrusted("/p/a")).toBe(false);
  t.setTrust("/p/a", true);
  expect(t.isTrusted("/p/a")).toBe(true);
  expect(t.list()).toEqual(["/p/a"]);
  t.setTrust("/p/a", false);
  expect(t.isTrusted("/p/a")).toBe(false);
  expect(t.list()).toEqual([]);
});

test("trust persists across reopen", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trust-")), "trust.db");
  openTrustStore(path).setTrust("/p/b", true);
  expect(openTrustStore(path).isTrusted("/p/b")).toBe(true);
});

// ── Trust new projects by default (2026-10-02 amendment) ──────────────────────────────────────

test("trustNewProjects: the first sight of a never-seen folder trusts it, once", () => {
  const t = openTrustStore(":memory:", { trustNewProjects: true });
  expect(t.isTrusted("/p/new")).toBe(false); // reading never seeds
  expect(t.noteProject("/p/new")).toBe(true);
  expect(t.isTrusted("/p/new")).toBe(true);
  expect(t.list()).toEqual(["/p/new"]);
  expect(t.noteProject("/p/new")).toBe(false); // already seen: no-op
});

test("an explicit /trust off is remembered and never re-trusted by a later first-sight note", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trust-")), "trust.db");
  const t = openTrustStore(path, { trustNewProjects: true });
  t.noteProject("/p/x");
  t.setTrust("/p/x", false);
  expect(t.noteProject("/p/x")).toBe(false);
  expect(t.isTrusted("/p/x")).toBe(false);
  expect(t.list()).toEqual([]); // an explicit-off row is not a trusted folder
  // …and it survives a restart.
  const again = openTrustStore(path, { trustNewProjects: true });
  expect(again.noteProject("/p/x")).toBe(false);
  expect(again.isTrusted("/p/x")).toBe(false);
});

test("/trust off on a never-seen folder blocks the default too", () => {
  const t = openTrustStore(":memory:", { trustNewProjects: true });
  t.setTrust("/p/y", false);
  expect(t.noteProject("/p/y")).toBe(false);
  expect(t.isTrusted("/p/y")).toBe(false);
});

test("with the flag off, a first sight is recorded untrusted — turning the flag on later does not trust it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trust-")), "trust.db");
  const off = openTrustStore(path, { trustNewProjects: false });
  expect(off.noteProject("/p/seen")).toBe(false);
  expect(off.isTrusted("/p/seen")).toBe(false);
  const on = openTrustStore(path, { trustNewProjects: true });
  expect(on.noteProject("/p/seen")).toBe(false);
  expect(on.isTrusted("/p/seen")).toBe(false);
});

test("the store defaults to the old behaviour (no flag ⇒ a new folder is not trusted)", () => {
  const t = openTrustStore(":memory:");
  expect(t.noteProject("/p/z")).toBe(false);
  expect(t.isTrusted("/p/z")).toBe(false);
});

test("migration: legacy trusted rows stay trusted; known folders are marked seen-untrusted, once", () => {
  const path = join(mkdtempSync(join(tmpdir(), "neo-trust-")), "trust.db");
  const legacy = new Database(path);
  legacy.run(`CREATE TABLE trust (folder TEXT PRIMARY KEY)`);
  legacy.query(`INSERT INTO trust (folder) VALUES (?)`).run("/p/legacy-on");
  legacy.close();

  const t = openTrustStore(path, {
    trustNewProjects: true,
    knownFolders: () => ["/p/legacy-on", "/p/old-untrusted"],
  });
  expect(t.isTrusted("/p/legacy-on")).toBe(true); // existing trust kept
  expect(t.isTrusted("/p/old-untrusted")).toBe(false); // existing untrusted project kept untrusted
  expect(t.noteProject("/p/old-untrusted")).toBe(false);
  expect(t.isTrusted("/p/old-untrusted")).toBe(false);
  expect(t.noteProject("/p/brand-new")).toBe(true);
  expect(t.list()).toEqual(["/p/brand-new", "/p/legacy-on"]);

  // The backfill runs only at migration: a folder first worked in AFTER it is a new project.
  const reopened = openTrustStore(path, { trustNewProjects: true, knownFolders: () => ["/p/later"] });
  expect(reopened.noteProject("/p/later")).toBe(true);
  expect(reopened.isTrusted("/p/later")).toBe(true);
});
