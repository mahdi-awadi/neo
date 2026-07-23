// Memory file operations — entries, caps, apply.
// Entries are delimited as lines starting with `§ ` (section-sign + space).
// Ops are atomic: write to .tmp, then renameSync. Failed ops leave the file unchanged.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Approximation fact: chars per token used to convert window size to byte cap.
 * Exported for callers to understand the conversion formula. */
export const CHARS_PER_TOKEN = 4;

/** Memory config type. */
interface MemoryCfg {
  snapshotMaxPct: number;
  userMaxPct: number;
}

/** Returns the memory directory path for a given folder. */
export function memoryDir(folder: string): string {
  return join(folder, "memory");
}

/** Computes character caps from window size and config percentages.
 * chars = windowTokens * pct * CHARS_PER_TOKEN */
export function memoryCaps(
  cfg: MemoryCfg,
  windowTokens: number
): { memoryChars: number; userChars: number } {
  return {
    memoryChars: windowTokens * cfg.snapshotMaxPct * CHARS_PER_TOKEN,
    userChars: windowTokens * cfg.userMaxPct * CHARS_PER_TOKEN,
  };
}

/** Reads memory files from a folder, fail-open (missing → "").
 * Returns { memory, user } corresponding to MEMORY.md and USER.md. */
export function readMemoryFiles(folder: string): { memory: string; user: string } {
  const dir = memoryDir(folder);
  let memory = "";
  let user = "";

  try {
    const memoryPath = join(dir, "MEMORY.md");
    if (existsSync(memoryPath)) {
      memory = readFileSync(memoryPath, "utf-8");
    }
  } catch {
    // Fail open — missing or unreadable file returns ""
  }

  try {
    const userPath = join(dir, "USER.md");
    if (existsSync(userPath)) {
      user = readFileSync(userPath, "utf-8");
    }
  } catch {
    // Fail open
  }

  return { memory, user };
}

/** Memory operation kind and payload. */
export type MemoryOp =
  | { kind: "add"; text: string }
  | { kind: "replace"; oldText: string; text: string }
  | { kind: "remove"; oldText: string };

/** Applies a memory operation (add/replace/remove) to a file, atomically.
 * Replace swaps the whole matched entry with text (not a substring replacement).
 * Returns { ok: true } on success or { ok: false; error: string } on error.
 * Errors: "duplicate entry", "no match", "ambiguous match",
 * "empty text", "empty match text", "text contains the entry delimiter",
 * "over capacity (N/M chars) — consolidate or remove first" */
export function applyMemoryOp(
  folder: string,
  file: "MEMORY.md" | "USER.md",
  op: MemoryOp,
  capChars: number
): { ok: true } | { ok: false; error: string } {
  const dir = memoryDir(folder);
  const filepath = join(dir, file);

  // Ensure directory exists
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, error: "failed to create directory" };
  }

  // Read current file (fail-open)
  let content = "";
  try {
    if (existsSync(filepath)) {
      content = readFileSync(filepath, "utf-8");
    }
  } catch {
    return { ok: false, error: "failed to read file" };
  }

  // Parse entries (lines starting with "§ ")
  const entries = parseEntries(content);

  let newContent = "";
  try {
    if (op.kind === "add") {
      // Validate text: reject empty, whitespace-only, or containing delimiter
      if (!op.text || op.text.trim() === "") {
        return { ok: false, error: "empty text" };
      }
      if (op.text.includes("\n§ ") || op.text.startsWith("§ ")) {
        return { ok: false, error: "text contains the entry delimiter" };
      }
      // Check for duplicate
      if (entries.some((e) => e === op.text)) {
        return { ok: false, error: "duplicate entry" };
      }
      // Add new entry
      newContent = content ? content + "\n§ " + op.text : "§ " + op.text;
    } else if (op.kind === "replace") {
      // Validate text: reject empty, whitespace-only, or containing delimiter
      if (!op.text || op.text.trim() === "") {
        return { ok: false, error: "empty text" };
      }
      if (op.text.includes("\n§ ") || op.text.startsWith("§ ")) {
        return { ok: false, error: "text contains the entry delimiter" };
      }
      // Validate oldText: reject empty or whitespace-only
      if (!op.oldText || op.oldText.trim() === "") {
        return { ok: false, error: "empty match text" };
      }
      // Find all entries containing oldText
      const matchingIndices = entries
        .map((e, i) => (e.includes(op.oldText) ? i : -1))
        .filter((i) => i >= 0);

      if (matchingIndices.length === 0) {
        return { ok: false, error: "no match" };
      }
      if (matchingIndices.length > 1) {
        return { ok: false, error: "ambiguous match" };
      }

      // Replace the whole matched entry with text
      const idx = matchingIndices[0];
      entries[idx] = op.text;
      newContent = entries.map((e) => "§ " + e).join("\n");
    } else if (op.kind === "remove") {
      // Validate oldText: reject empty or whitespace-only
      if (!op.oldText || op.oldText.trim() === "") {
        return { ok: false, error: "empty match text" };
      }
      // Find all entries containing oldText
      const matchingIndices = entries
        .map((e, i) => (e.includes(op.oldText) ? i : -1))
        .filter((i) => i >= 0);

      if (matchingIndices.length === 0) {
        return { ok: false, error: "no match" };
      }
      if (matchingIndices.length > 1) {
        return { ok: false, error: "ambiguous match" };
      }

      // Remove the matching entry
      entries.splice(matchingIndices[0], 1);
      newContent = entries.map((e) => "§ " + e).join("\n");
    }
  } catch (e) {
    return { ok: false, error: `operation failed: ${String(e)}` };
  }

  // Check capacity
  if (newContent.length > capChars) {
    return {
      ok: false,
      error: `over capacity (${newContent.length}/${capChars} chars) — consolidate or remove first`,
    };
  }

  // Atomic write: write to .tmp, then rename
  const tmpPath = filepath + ".tmp";
  try {
    writeFileSync(tmpPath, newContent, "utf-8");
    renameSync(tmpPath, filepath);
  } catch (e) {
    return { ok: false, error: `atomic write failed: ${String(e)}` };
  }

  return { ok: true };
}

/** Parse entries from memory file content.
 * Entries are delimited as lines starting with "§ " (section-sign + space). */
function parseEntries(content: string): string[] {
  if (!content) return [];

  // Split by \n§ to get entries (the first might not have §)
  const parts = content.split("\n§ ");
  const entries: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    // Remove leading "§ " from the first part if present
    if (i === 0 && part.startsWith("§ ")) {
      part = part.slice(2);
    }
    if (part) {
      entries.push(part);
    }
  }

  return entries;
}
