// Test preload: Neo's handoff notes go to a throwaway dir, never the repo's data/handoffs (ADR-0029).
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setNeoNotesDir } from "../src/engine/context-policy";

setNeoNotesDir(mkdtempSync(join(tmpdir(), "neo-notes-")));
