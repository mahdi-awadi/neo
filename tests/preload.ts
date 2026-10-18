// Test preload.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setNeoNotesDir } from "../src/engine/context-policy";

// The test temp root (ADR-0042): one folder per run holds every temp folder the tests make (each
// `tmpdir()` call and each child process reads TMPDIR), and the run removes it after its last test.
// Tests that never clean up can no longer fill /tmp. `bun test` fires no process "exit" event, so a
// preload-level afterAll (global: once, after every file) does the removal. A killed run leaves one
// folder, which the disk-cleanup /tmp rule ages out.
const root = mkdtempSync(join(tmpdir(), "neo-test-"));
process.env.TMPDIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Neo's handoff notes go to a throwaway dir, never the repo's data/handoffs (ADR-0029).
setNeoNotesDir(mkdtempSync(join(tmpdir(), "neo-notes-")));
