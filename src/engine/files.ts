// Inbound files: the operator attaches a file in a channel; the engine saves it into the
// target project's inbox/ so the worker can Read it. Name is sanitized (no path traversal)
// and de-duplicated. Pure filesystem helper — tested directly, no channel.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

/** Save `bytes` to `<folder>/inbox/<sanitized filename>`, deduping collisions. Returns the path. */
export function saveInbound(folder: string, filename: string, bytes: Uint8Array): string {
  let safe = basename(filename).replace(/[^A-Za-z0-9._-]/g, "_") || "file";
  if (safe === "." || safe === "..") safe = "file";
  const dir = join(folder, "inbox");
  mkdirSync(dir, { recursive: true });
  let target = join(dir, safe);
  if (existsSync(target)) {
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    for (let i = 2; existsSync(target); i++) target = join(dir, `${stem}-${i}${ext}`);
  }
  writeFileSync(target, bytes);
  return target;
}
