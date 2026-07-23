// Memory file operations — entries, caps, apply.
// Entries are delimited as lines starting with `§ ` (section-sign + space).
// Ops are atomic: write to .tmp, then renameSync. Failed ops leave the file unchanged.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, copyFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { MemoryCfg } from "../config";
import { openMemoryIndex } from "./memory-recall";

// Re-export so existing importers of memory.ts's local type keep working.
export type { MemoryCfg };

/** Approximation fact: chars per token used to convert window size to byte cap.
 * Exported for callers to understand the conversion formula. */
export const CHARS_PER_TOKEN = 4;

/** Returns the memory directory path for a given folder. */
export function memoryDir(folder: string): string {
  return join(folder, "memory");
}

/** Returns the daily-log directory path for a given folder. */
function logDir(folder: string): string {
  return join(memoryDir(folder), "log");
}

/** Today's local date as YYYY-MM-DD, from `new Date()` (engine code — allowed; workers never
 * compute "today" themselves). */
function todayLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Appends one line to the day's log file (`<folder>/memory/log/<day>.md`, dir auto-created) and
 * indexes it into the folder's FTS5 recall index (memory-recall.ts) so it becomes searchable with
 * a file+day citation. `day` defaults to today's local date (YYYY-MM-DD).
 *
 * Fail-closed against log poisoning: the line is run through the same `scanMemoryText` write-time
 * scan used by `applyMemoryOp` first; a line that fails the scan is silently NOT appended and NOT
 * indexed (no error is thrown or returned — this mirrors the log's append-only, best-effort
 * nature, and keeps a scanned-out line from ever reaching disk or the recall index). */
export function appendDailyLog(folder: string, line: string, day?: string): void {
  if (scanMemoryText(line)) return; // fail closed — never append/index a line that fails the scan

  const d = day ?? todayLocalDate();
  const dir = logDir(folder);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return; // best-effort — can't create the dir, nothing to append
  }

  const path = join(dir, `${d}.md`);
  try {
    appendFileSync(path, `- ${line}\n`, "utf-8");
  } catch {
    return; // best-effort — failed append, skip indexing too (nothing was written)
  }

  try {
    openMemoryIndex(folder).indexLine(path, d, line);
  } catch {
    // Best-effort — the log file is the source of truth; a failed index write just means this
    // line isn't searchable yet (it can be recovered by a future indexFile re-index).
  }
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

/** Canonicalise a folder path for comparison (symlink- and trailing-slash-insensitive).
 * Mirrors codebase-memory.ts's `canonical()`. */
function canonical(folder: string): string {
  try {
    return realpathSync(resolve(folder));
  } catch {
    return resolve(folder);
  }
}

/** True when `folder` is in scope for the memory system: `cfg.scopes` contains the literal
 * keyword `"company"` and `folder` resolves to `companyFolder`, OR `cfg.scopes` contains
 * `folder`'s own absolute path. Default `scopes: []` → always false (feature off). */
export function memoryScopeEnabled(cfg: MemoryCfg, folder: string, companyFolder: string): boolean {
  const target = canonical(folder);
  if (cfg.scopes.includes("company") && target === canonical(companyFolder)) return true;
  return cfg.scopes.some((s) => s !== "company" && canonical(s) === target);
}

/** Ground-truth wrapper injected once at worker start (frozen for the run's lifetime). Empty
 * string when both MEMORY.md and USER.md are empty — a total no-op for an unpopulated folder. */
export function memorySnapshot(folder: string, cfg: MemoryCfg): string {
  void cfg; // reserved for future truncation-at-inject; files are already capped at write time
  const { memory, user } = readMemoryFiles(folder);
  if (!memory && !user) return "";
  let out =
    "[MEMORY — authoritative ground truth. Facts here override guesses. Written by you in past\n" +
    "sessions; update via the memory tool (writes apply next session, never this one).]\n" +
    memory;
  if (user) {
    out += "\n[USER]\n" + user;
  }
  out += "\n[END MEMORY]";
  return out;
}

/** Deterministic write-time scan for memory entries — a blast-radius reducer, not a guarantee.
 * These patterns catch the cheapest, most common poisoning/leak shapes that could end up in a
 * memory file and get read back into every future session's context: credential-looking
 * strings, prompt-injection phrases, and invisible unicode used to smuggle hidden text. This is
 * NOT a security boundary — the governor (default-escalate tool policy, path fence, tainted-brief
 * zero-tools rule) remains the real gate. A worker or operator input that clears this scan can
 * still be stopped by the governor; this scan only removes the cheap, common cases from memory. */
export const MEMORY_SCAN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}/i, reason: "looks like a credential" },
  { pattern: /ghp_[A-Za-z0-9]{30,}/, reason: "looks like a GitHub token" },
  { pattern: /sk-[A-Za-z0-9]{20,}/, reason: "looks like an API secret key" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "looks like a private key" },
  { pattern: /ignore (all )?previous instructions/i, reason: "looks like a prompt-injection phrase" },
  { pattern: /<system-reminder/i, reason: "looks like an injected system-reminder tag" },
  { pattern: /[\u200b-\u200f\u2028\u2029\ufeff]/, reason: "contains invisible unicode" },
];

/** Scans text before it can be written into a memory file.
 * Returns undefined when clean, else the reason string for the first pattern that matched. */
export function scanMemoryText(text: string): string | undefined {
  for (const { pattern, reason } of MEMORY_SCAN_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return undefined;
}

function hashesPath(folder: string): string {
  return join(memoryDir(folder), ".hashes.json");
}

function backupsDir(folder: string): string {
  return join(memoryDir(folder), ".backups");
}

function readHashes(folder: string): Record<string, string> {
  try {
    const p = hashesPath(folder);
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  } catch {
    // Fail open — treat as no recorded hashes
  }
  return {};
}

function writeHashes(folder: string, hashes: Record<string, string>): void {
  try {
    mkdirSync(memoryDir(folder), { recursive: true });
    writeFileSync(hashesPath(folder), JSON.stringify(hashes), "utf-8");
  } catch {
    // Best-effort — a failed hash write just makes the next op re-check conservatively
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Anti-poisoning drift guard: if the file on disk no longer matches the hash of the engine's
 * last write, copies the current (drifted) content to `.backups/<file>.<Date.now()>.md` before
 * the next op is applied. Operator/external edits are preserved, never reverted — the next op
 * still applies on top of the drifted content. A file with no recorded hash (first-ever write)
 * is never backed up. */
export function ensureDriftBackup(folder: string, file: string): void {
  const filepath = join(memoryDir(folder), file);
  if (!existsSync(filepath)) return;

  const hashes = readHashes(folder);
  const recorded = hashes[file];
  if (recorded === undefined) return; // first-ever write — nothing to compare against

  let current: string;
  try {
    current = readFileSync(filepath, "utf-8");
  } catch {
    return;
  }

  if (sha256(current) === recorded) return; // no drift

  try {
    mkdirSync(backupsDir(folder), { recursive: true });
    const backupPath = join(backupsDir(folder), `${file}.${Date.now()}.md`);
    copyFileSync(filepath, backupPath);
  } catch {
    // Best-effort — do not block the op on backup failure
  }
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

  // Anti-poisoning drift guard: back up any externally-edited content before this op touches it
  ensureDriftBackup(folder, file);

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
      // Deterministic write-time scan (blast-radius reducer, not a guarantee)
      const addScanReason = scanMemoryText(op.text);
      if (addScanReason) {
        return { ok: false, error: `rejected by scan: ${addScanReason}` };
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

      // Deterministic write-time scan (blast-radius reducer, not a guarantee)
      const replaceScanReason = scanMemoryText(op.text);
      if (replaceScanReason) {
        return { ok: false, error: `rejected by scan: ${replaceScanReason}` };
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

  // Record this write's hash so the next op can detect external drift
  const hashes = readHashes(folder);
  hashes[file] = sha256(newContent);
  writeHashes(folder, hashes);

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
