// Memory file operations — entries, caps, apply.
// Entries are delimited as lines starting with `§ ` (section-sign + space).
// Ops are atomic: write to .tmp, then renameSync. Failed ops leave the file unchanged.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, copyFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { MemoryCfg } from "../config";
import { openMemoryIndex } from "./memory-recall";
import { windowTokensFor } from "./context-policy";

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
 * indexed (no error is thrown or returned as an error — this mirrors the log's append-only,
 * best-effort nature, and keeps a scanned-out line from ever reaching disk or the recall index).
 *
 * Returns `true` only when the line was actually written to the log file — `false` when it was
 * scan-rejected, OR when a filesystem failure (unwritable `memory/` dir, full disk, etc.) meant
 * NOTHING was appended. A failure to index the already-written line afterward does not flip this
 * back to `false` (the log file is the source of truth — see the indexing try/catch below); only
 * disk-append success matters for the return value. Existing callers that ignore the return value
 * are unaffected (additive; grep confirms none inspected it before this change). */
export function appendDailyLog(folder: string, line: string, day?: string): boolean {
  ensureExcluded(folder); // lazy, once-per-process git-exclude hygiene (never blocks the write)
  if (scanMemoryText(line)) return false; // fail closed — never append/index a line that fails the scan

  const d = day ?? todayLocalDate();
  const dir = logDir(folder);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return false; // best-effort — can't create the dir, nothing to append
  }

  const path = join(dir, `${d}.md`);
  try {
    appendFileSync(path, `- ${line}\n`, "utf-8");
  } catch {
    return false; // best-effort — failed append, skip indexing too (nothing was written)
  }

  try {
    openMemoryIndex(folder).indexLine(path, d, line);
  } catch {
    // Best-effort — the log file is the source of truth; a failed index write just means this
    // line isn't searchable yet (it can be recovered by a future indexFile re-index). The append
    // itself succeeded, so this still returns true.
  }

  return true;
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

// Module-level per-process cache of folders already checked by ensureExcluded — same idiom as
// memory-recall.ts's indexCache, keyed by canonical (realpath) folder path so a folder is only
// ever touched once per process regardless of how many applyMemoryOp/appendDailyLog calls come in.
const excludeChecked = new Set<string>();

/** Git-exclude hygiene: appends `memory/` to `<folder>/.git/info/exclude` (creating the file, and
 * its `info/` dir, if missing) so an operator's project repo doesn't need `memory/` added to its
 * TRACKED `.gitignore` — machine-local law, this never touches a tracked file. No-op when `folder`
 * isn't a real git repo: `existsSync(<folder>/.git)` is the check, which is true whether `.git` is
 * the usual directory or the single-file gitdir pointer a git worktree uses — either way counts as
 * "a real git repo" for this check. Also a no-op when the line is already present. Runs at most
 * once per process per folder (see `excludeChecked` above) — called lazily from the write paths
 * (`applyMemoryOp`, `appendDailyLog`). Fail-open: never throws — any filesystem error (including a
 * worktree's `.git` being a file, which makes `<folder>/.git/info` an invalid path to mkdir under)
 * is swallowed, since this is hygiene, not a guarantee, and must never block a memory write. */
export function ensureExcluded(folder: string): void {
  const key = canonical(folder);
  if (excludeChecked.has(key)) return;
  excludeChecked.add(key);
  try {
    if (!existsSync(join(folder, ".git"))) return;
    const infoDir = join(folder, ".git", "info");
    mkdirSync(infoDir, { recursive: true });
    const excludePath = join(infoDir, "exclude");
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
    if (existing.split("\n").some((line) => line.trim() === "memory/")) return; // already present
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${sep}memory/\n`, "utf-8");
  } catch {
    // Fail-open — git-exclude hygiene must never block a memory write.
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

/** Scans a memory file's content entry-by-entry (whole-entry granularity, mirroring
 * applyMemoryOp's own "§ "-delimited parsing), drops entries the write-time scan would reject —
 * covering drift the scan never saw at write time (a hand-edit, an externally-written file) — and
 * cap-includes the survivors in order up to `capChars`, stopping BEFORE the entry that would push
 * the total over the cap. Returns the rebuilt content plus a short bracketed notice (empty when
 * nothing was withheld or truncated) so an injected snapshot tells the worker it was filtered
 * rather than silently shrinking. A single non-"§ "-formatted blob (parseEntries' one-entry
 * fallback) is scanned/capped as one whole entry, so this applies uniformly either way. */
function scannedAndCapped(content: string, capChars: number): { content: string; notice: string } {
  const entries = parseEntries(content);
  const kept: string[] = [];
  let withheld = 0;
  for (const e of entries) {
    if (scanMemoryText(e)) {
      withheld++;
    } else {
      kept.push(e);
    }
  }

  const included: string[] = [];
  let len = 0;
  let truncated = false;
  for (const e of kept) {
    const entryLen = (included.length > 0 ? "\n§ " : "§ ").length + e.length;
    if (len + entryLen > capChars) {
      truncated = true;
      break;
    }
    included.push(e);
    len += entryLen;
  }

  const notices: string[] = [];
  if (withheld > 0) notices.push(`[${withheld} entr${withheld === 1 ? "y" : "ies"} withheld by scan]`);
  if (truncated) notices.push("[truncated at cap]");

  return { content: included.map((e) => "§ " + e).join("\n"), notice: notices.join(" ") };
}

/** Shared gate: true only when BOTH `memory` and `companyFolder` are set AND `memoryScopeEnabled`
 * says `folder` is in scope. Every call site across the engine that decides "is memory on for this
 * folder" (dispatch's memoryGate, idle.ts's idle-close log line, reload.ts's drain wrap-up flush,
 * pipeline's fresh-start snapshot + handoff flush) routes through this ONE function so the check
 * can never drift between sites. Semantics are IDENTICAL to each site's own inline
 * undefined-checks-then-memoryScopeEnabled from before this function existed — this only removes
 * the duplication. `memory`/`companyFolder` optional because some callers (dispatch's
 * DispatchDeps, idle/reload's opts) may omit them entirely (e.g. the customer/ingress path) — the
 * fail-closed default there is "not enabled". */
export function memoryEnabledFor(memory: MemoryCfg | undefined, folder: string, companyFolder: string | undefined): boolean {
  if (memory === undefined || companyFolder === undefined) return false;
  return memoryScopeEnabled(memory, folder, companyFolder);
}

/** Ground-truth wrapper injected once at worker start (frozen for the run's lifetime). Empty
 * string when both MEMORY.md and USER.md are empty — a total no-op for an unpopulated folder.
 *
 * `cfg` sizes the SAME ratio caps (memoryCaps) the write path enforces (memoryChars/userChars,
 * via windowTokensFor's default window — no model is known yet at inject time), so drifted or
 * externally-grown content can never inject more than a normally-capped file would ever have held.
 * Each file's content is also run through the write-time scan (scanMemoryText) at compose time —
 * belt-and-braces against a file that drifted (hand-edit, external write) to contain something the
 * scan would have rejected had it gone through applyMemoryOp. Flagged/over-cap entries are dropped
 * with a bracketed notice (count only, never the content) rather than silently included or
 * silently shrunk. */
export function memorySnapshot(folder: string, cfg: MemoryCfg): string {
  const { memory, user } = readMemoryFiles(folder);
  if (!memory && !user) return "";
  const caps = memoryCaps(cfg, windowTokensFor(undefined));

  const memF = scannedAndCapped(memory, caps.memoryChars);
  let out =
    "[MEMORY — authoritative ground truth. Facts here override guesses. Written by you in past\n" +
    "sessions; update via the memory tool (writes apply next session, never this one).]\n" +
    memF.content;
  if (memF.notice) out += "\n" + memF.notice;

  if (user) {
    const userF = scannedAndCapped(user, caps.userChars);
    out += "\n[USER]\n" + userF.content;
    if (userF.notice) out += "\n" + userF.notice;
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

/** Records `content`'s hash as the last-known-good write for `file`, the same bookkeeping
 * `applyMemoryOp` does after its own atomic write. Exported additively for callers that write a
 * memory file's content OUTSIDE applyMemoryOp's own write path (e.g. memory-tool.ts's dream-mode
 * revert, which restores a file's prior content directly) — without this, the next legitimate
 * `applyMemoryOp` call would see a stale recorded hash, read it as external drift, and spawn a
 * spurious `.backups` copy via ensureDriftBackup. applyMemoryOp's own internals are unchanged. */
export function recordMemoryHash(folder: string, file: string, content: string): void {
  const hashes = readHashes(folder);
  hashes[file] = sha256(content);
  writeHashes(folder, hashes);
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
  ensureExcluded(folder); // lazy, once-per-process git-exclude hygiene (never blocks the write)
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
