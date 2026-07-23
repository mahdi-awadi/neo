// memory-tool.ts — the worker-facing MCP surface for the memory system (Phase 2 Task 5):
// `memory` (mutate MEMORY.md/USER.md via applyMemoryOp) and `memory_search` (cited recall over
// the daily log via memory-recall.ts's FTS5 index). Writes apply NEXT session — the snapshot a
// worker sees at start is frozen for the run (see memory.ts's memorySnapshot).
//
// Dream mode (opts.dream): engine-enforced budgets for an autonomous "dream" consolidation run
// (a later task's loop — this file only supplies the budget mechanics). A closure tallies
// mutations/adds/net-chars across every `memory` call made through the SAME memoryTools(...)
// instance; an op that would exceed any budget is rejected WITHOUT taking effect (net-chars is
// checked by measuring the real before/after file-size delta and reverting the write if it would
// blow the budget — applyMemoryOp has no dry-run mode, so a measure-then-revert is the simplest
// correct way to know the true growth of a replace/remove before committing to it). Every attempt
// (applied or rejected) is appended to the caller-supplied diary callback; the caller decides
// where that line goes (the loop task writes it to <folder>/memory/DREAMS.md). Before the first
// attempted mutation of a run, both memory files are backed up to
// `<folder>/memory/.backups/<file>.<Date.now()>.md` (mirrors memory.ts's own drift-backup
// convention) — this happens once, before the attempt, so the backup is always genuinely pre-run
// even if that first attempt goes on to fail inside applyMemoryOp (scan rejection, no match, …).

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MemoryCfg } from "../config";
import { applyMemoryOp, memoryCaps, memoryDir, type MemoryOp } from "./memory";
import { openMemoryIndex } from "./memory-recall";

type MemoryFile = "MEMORY.md" | "USER.md";
type MemoryOpKind = "add" | "replace" | "remove";

/** memory_search's limit when the caller omits one — an interface default, not a hard floor. */
const DEFAULT_SEARCH_LIMIT = 5;
/** memory_search's hard ceiling on `limit` — an interface bound (zod-enforced too). */
const MAX_SEARCH_LIMIT = 20;

const MEMORY_TOOL_DESCRIPTION =
  "Edit your own long-term memory (MEMORY.md or USER.md). Writes apply NEXT session — the " +
  "current snapshot is frozen for this run.\n\n" +
  "SAVE: explicit corrections/instructions; preferences emerging from patterns; " +
  "environment/project facts; hard-won workarounds.\n" +
  "SKIP: session ephemera; easily rediscoverable facts; raw logs; anything already in context files.";

const MEMORY_SEARCH_DESCRIPTION =
  `Search your daily-log memory for past entries relevant to \`query\`. Every hit is cited with ` +
  `its file and day. \`limit\` defaults to ${DEFAULT_SEARCH_LIMIT} (max ${MAX_SEARCH_LIMIT} — an ` +
  `interface bound).`;

/** Dream-mode budgets + diary, threaded through memoryTools' closure. */
export interface DreamOpts {
  /** Max total mutations (successful add/replace/remove) allowed this run. */
  maxMutations: number;
  /** Max successful `add`s allowed this run (a subset of maxMutations). */
  maxAdds: number;
  /** Max net character growth across memory files allowed this run. */
  maxNetChars: number;
  /** Called once per memory-op ATTEMPT (applied or rejected) with a one-line summary. The caller
   *  decides where this goes (e.g. append to a DREAMS.md file). */
  diary: (line: string) => void;
}

function toMemoryOp(op: MemoryOpKind, text: string | undefined, oldText: string | undefined): MemoryOp {
  if (op === "add") return { kind: "add", text: text ?? "" };
  if (op === "replace") return { kind: "replace", oldText: oldText ?? "", text: text ?? "" };
  return { kind: "remove", oldText: oldText ?? "" };
}

/** Reads `folder`'s memory/`file`, fail-open to "" (missing/unreadable → empty, never throws). */
function readFileRaw(folder: string, file: MemoryFile): string {
  try {
    const p = join(memoryDir(folder), file);
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  } catch {
    return "";
  }
}

/** Formats the current usage of `file` against its cap for the tool's success text, e.g.
 *  "MEMORY.md 34% (1090/3200 chars)". */
function usageLine(folder: string, file: MemoryFile, capChars: number): string {
  const len = readFileRaw(folder, file).length;
  const pct = capChars > 0 ? Math.round((len / capChars) * 100) : 0;
  return `${file} ${pct}% (${len}/${capChars} chars)`;
}

const textContent = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** Builds the two worker-facing memory MCP tools for `folder`. `windowTokens` sizes the ratio
 *  caps (memoryCaps) — MEMORY.md → memoryChars, USER.md → userChars. `opts.dream`, when present,
 *  turns on engine-enforced dream budgets scoped to THIS memoryTools(...) call (a fresh call gets
 *  a fresh, zeroed closure — callers must build one memoryTools() per dream run). */
export function memoryTools(
  folder: string,
  cfg: MemoryCfg,
  windowTokens: number,
  opts?: { dream?: DreamOpts },
): SdkMcpToolDefinition<any>[] {
  const caps = memoryCaps(cfg, windowTokens);
  const capFor = (file: MemoryFile) => (file === "MEMORY.md" ? caps.memoryChars : caps.userChars);

  const dream = opts?.dream;
  let mutations = 0;
  let adds = 0;
  let netChars = 0;
  let backedUp = false;

  /** One-shot, idempotent: copies both memory files (if present) to .backups/<file>.<ts>.md.
   *  Called right before the FIRST attempted mutation (whether or not it goes on to succeed), so
   *  the snapshot it captures is always genuinely pre-run. */
  function ensureDreamBackup(): void {
    if (backedUp) return;
    backedUp = true;
    const dir = memoryDir(folder);
    try {
      mkdirSync(join(dir, ".backups"), { recursive: true });
    } catch {
      return; // best-effort — never block the op on a failed backup
    }
    const ts = Date.now();
    for (const file of ["MEMORY.md", "USER.md"] as const) {
      const p = join(dir, file);
      try {
        if (existsSync(p)) copyFileSync(p, join(dir, ".backups", `${file}.${ts}.md`));
      } catch {
        // best-effort — one file's backup failing must not block the other or the op
      }
    }
  }

  function diaryLine(op: MemoryOpKind, file: MemoryFile, outcome: string, reason: string | undefined): void {
    dream?.diary(`${op} ${file}: ${outcome} — ${reason ?? "no reason given"}`);
  }

  const memoryTool = tool(
    "memory",
    MEMORY_TOOL_DESCRIPTION,
    {
      file: z.enum(["MEMORY.md", "USER.md"]),
      op: z.enum(["add", "replace", "remove"]),
      text: z.string().optional(),
      old_text: z.string().optional(),
      reason: z.string().optional(),
    },
    async (args: { file: MemoryFile; op: MemoryOpKind; text?: string; old_text?: string; reason?: string }) => {
      const { file, op, text, old_text: oldText, reason } = args;

      if (dream) {
        if (mutations >= dream.maxMutations) {
          diaryLine(op, file, "rejected: dream budget exhausted: mutations", reason);
          return textContent("dream budget exhausted: mutations");
        }
        if (op === "add" && adds >= dream.maxAdds) {
          diaryLine(op, file, "rejected: dream budget exhausted: adds", reason);
          return textContent("dream budget exhausted: adds");
        }
        ensureDreamBackup(); // before the first ATTEMPTED mutation, success or not
      }

      const before = dream ? readFileRaw(folder, file) : "";
      const result = applyMemoryOp(folder, file, toMemoryOp(op, text, oldText), capFor(file));

      if (!result.ok) {
        diaryLine(op, file, `rejected: ${result.error}`, reason);
        return textContent(result.error);
      }

      if (dream) {
        const after = readFileRaw(folder, file);
        const growth = after.length - before.length; // net chars added (may be <=0 for replace/remove)
        if (netChars + growth > dream.maxNetChars) {
          // Revert: applyMemoryOp has no dry-run, so the only way to know the true growth of a
          // replace/remove ahead of time is to apply it and measure — undo it here to keep the
          // net effect "rejected, not applied".
          try {
            writeFileSync(join(memoryDir(folder), file), before, "utf-8");
          } catch {
            // best-effort — if the revert write itself fails, the op regrettably stands; still
            // report the rejection so the caller/diary reflect the intended outcome.
          }
          diaryLine(op, file, "rejected: dream budget exhausted: net chars", reason);
          return textContent("dream budget exhausted: net chars");
        }
        netChars += growth;
        mutations += 1;
        if (op === "add") adds += 1;
      }

      diaryLine(op, file, "applied", reason);
      return textContent(`saved — ${usageLine(folder, file, capFor(file))}`);
    },
  );

  const searchTool = tool(
    "memory_search",
    MEMORY_SEARCH_DESCRIPTION,
    {
      query: z.string(),
      limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
    },
    async (args: { query: string; limit?: number }) => {
      const hits = openMemoryIndex(folder).search(args.query, args.limit ?? DEFAULT_SEARCH_LIMIT);
      if (hits.length === 0) return textContent("no matches");
      return textContent(hits.map((h) => `${h.content} — ${h.file} (${h.day})`).join("\n"));
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [memoryTool, searchTool] as SdkMcpToolDefinition<any>[];
}
