// memory-tool.ts — the worker-facing MCP surface for the memory system (Phase 2 Task 5):
// `memory` (mutate MEMORY.md/USER.md via applyMemoryOp) and `memory_search` (cited recall over
// the daily log via memory-recall.ts's FTS5 index). Writes apply NEXT session — the snapshot a
// worker sees at start is frozen for the run (see memory.ts's memorySnapshot).
//
// Dream mode (opts.dream): engine-enforced budgets for an autonomous "dream" consolidation run
// (a later task's loop — this file only supplies the budget mechanics). A closure tallies
// mutations/adds/net-chars across every `memory` call made through the SAME memoryTools(...)
// instance; an op that would exceed any budget is rejected WITHOUT taking effect.
//
// `add`'s growth is exact and cheap to predict from the current file content (mirrors
// applyMemoryOp's own "\n§ "/"§ " prefix logic), so an over-budget add is pre-rejected before
// ever touching the file. `replace`/`remove`'s growth depends on which entry matches `old_text`
// (unknowable without applying — applyMemoryOp has no dry-run mode), so those go through
// apply-then-measure-then-revert-if-over-budget instead.
//
// Revert honesty: if the revert write itself throws, the over-budget mutation STANDS on disk —
// that must never be silently misreported as "rejected". On a revert failure this file (a) counts
// the mutation that actually landed against the budget counters, (b) diaries a distinct
// "applied (OVER BUDGET — revert failed)" line instead of "rejected", (c) returns a distinct tool
// error naming the mutation as landed, and (d) hard-stops every further mutation this run
// (fail-safe — the budget bookkeeping can no longer be trusted once one revert has failed).
//
// Every attempt (applied or rejected) is appended to the caller-supplied diary callback; the
// caller decides where that line goes (the loop task writes it to <folder>/memory/DREAMS.md).
// Before the first ATTEMPTED mutation of a run (one that's passed the count-based pre-checks —
// not a rejection that never touches the file), both memory files are backed up to
// `<folder>/memory/.backups/<file>.<Date.now()>.md` (mirrors memory.ts's own drift-backup
// convention). A successful revert also re-records the file's content hash (memory.ts's
// recordMemoryHash) so the NEXT legitimate applyMemoryOp call doesn't mistake the revert for
// external drift and spawn a spurious backup of its own.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MemoryCfg } from "../config";
import { applyMemoryOp, memoryCaps, memoryDir, recordMemoryHash, type MemoryOp } from "./memory";
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
  opts?: {
    dream?: DreamOpts;
    /** TEST-ONLY seam: overrides the raw write memory-tool.ts uses to revert an over-budget
     *  net-chars mutation, so a test can simulate a revert failure (e.g. a disk/permission error)
     *  deterministically. Defaults to a plain `writeFileSync`. Never set this outside a test. */
    __revertWrite?: (path: string, content: string) => void;
  },
): SdkMcpToolDefinition<any>[] {
  const caps = memoryCaps(cfg, windowTokens);
  const capFor = (file: MemoryFile) => (file === "MEMORY.md" ? caps.memoryChars : caps.userChars);

  const dream = opts?.dream;
  const revertWrite = opts?.__revertWrite ?? ((path: string, content: string) => writeFileSync(path, content, "utf-8"));
  let mutations = 0;
  let adds = 0;
  let netChars = 0;
  let backedUp = false;
  // Fail-safe: set the moment a revert write itself throws — the budget bookkeeping can no
  // longer be trusted (an over-budget mutation is sitting on disk), so every further mutation
  // this run is refused outright rather than risk compounding the honesty problem.
  let hardStop = false;

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
        if (hardStop) {
          diaryLine(op, file, "rejected: dream run halted (prior revert failure)", reason);
          return textContent("dream budget exhausted: run halted after a revert failure");
        }
        if (mutations >= dream.maxMutations) {
          diaryLine(op, file, "rejected: dream budget exhausted: mutations", reason);
          return textContent("dream budget exhausted: mutations");
        }
        if (op === "add" && adds >= dream.maxAdds) {
          diaryLine(op, file, "rejected: dream budget exhausted: adds", reason);
          return textContent("dream budget exhausted: adds");
        }
        if (op === "add") {
          // Exact, cheap prediction of an add's growth — mirrors applyMemoryOp's own
          // "\n§ "/"§ " prefix logic — so an over-budget add is rejected WITHOUT ever touching
          // the file (no apply-then-revert needed for this case).
          const existing = readFileRaw(folder, file);
          const prefixLen = existing.length > 0 ? "\n§ ".length : "§ ".length;
          const projectedGrowth = prefixLen + (text?.length ?? 0);
          if (netChars + projectedGrowth > dream.maxNetChars) {
            diaryLine(op, file, "rejected: dream budget exhausted: net chars", reason);
            return textContent("dream budget exhausted: net chars");
          }
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
        // `add` was already pre-checked above and never reaches this branch over budget; only
        // replace/remove (whose growth needed the real match) can still land here over budget.
        if (op !== "add" && netChars + growth > dream.maxNetChars) {
          const filepath = join(memoryDir(folder), file);
          try {
            revertWrite(filepath, before);
          } catch {
            // The revert itself failed — the over-budget mutation STANDS on disk. Be honest:
            // count what actually landed, diary it as applied (not rejected), hard-stop further
            // mutations this run, and return a distinct error so the caller knows the budget can
            // no longer be trusted.
            netChars += growth;
            mutations += 1;
            hardStop = true;
            diaryLine(op, file, "applied (OVER BUDGET — revert failed)", reason);
            return textContent(
              "over budget AND revert failed — mutation stands; treat this run's budget as exhausted",
            );
          }
          // Revert succeeded: re-record the (reverted) content's hash so the next legitimate
          // applyMemoryOp call doesn't mistake this revert for external drift.
          recordMemoryHash(folder, file, before);
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
