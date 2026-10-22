// Markdown files for the console (ADR-0046): the one seam that decides whether a path a worker wrote
// may be downloaded, and reads it. The host is public, so this is an arbitrary-file-read boundary:
// absolute paths only, `.md` only, no hidden, `.`/`..` or secret-named segment (the security kit's
// rule, reused), and the SAME rules again on the real path, which must sit inside a readable root.
// The bytes come from one O_NOFOLLOW descriptor whose fstat passed, so what is sent is what was checked.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, sep } from "node:path";
import { isSecretName } from "../../tools/security/guard";

/** Config `mdFiles` (docs/CONFIG.md). */
export interface MdFilesCfg {
  /** Readable roots: absolute folders the console may serve `.md` files from. Default `[workRoot]`. */
  roots: string[];
  /** Largest file served, in bytes. Default 2 MiB. */
  maxBytes: number;
}

export const DEFAULT_MD_FILES_MAX_BYTES = 2 * 1024 * 1024;

/** Parse the config value; a missing or bad field keeps its default (a bad value never opens the fence). */
export function readMdFilesCfg(raw: unknown, workRoot: string): MdFilesCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const roots = Array.isArray(r.roots) ? r.roots.filter((x): x is string => typeof x === "string" && isAbsolute(x)) : [];
  const max = r.maxBytes;
  return {
    roots: roots.length ? roots : [workRoot],
    maxBytes: typeof max === "number" && Number.isInteger(max) && max > 0 ? max : DEFAULT_MD_FILES_MAX_BYTES,
  };
}

export type MdFileResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; name: string; real: string }
  | { ok: false; status: 400 | 403 | 404 | 413; reason: string; real?: string };

const MD = /\.md$/i;
const PATH_MAX = 4096;

/** The rule every form of the path must pass (as asked, and as resolved): a reason, or undefined. */
function refusal(path: string): string | undefined {
  const segs = path.split("/").slice(1);
  if (segs.some((s) => s.startsWith("."))) return "hidden segment";
  if (segs.some((s) => isSecretName(s))) return "secret name";
  if (!MD.test(basename(path))) return "not markdown";
  return undefined;
}

/** True when `real` is a root or inside it (both already real paths). */
const inside = (real: string, root: string) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);

function realRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(realpathSync(r));
    } catch {
      // a missing root is skipped
    }
  }
  return out;
}

export function resolveMdFile(path: string, cfg: MdFilesCfg): MdFileResult {
  if (!path || path.length > PATH_MAX || path.includes("\0") || !isAbsolute(path)) return { ok: false, status: 400, reason: "bad path" };
  if (path.split("/").some((s) => s === "." || s === "..")) return { ok: false, status: 400, reason: "dot segment" };
  const asked = refusal(path);
  if (asked) return { ok: false, status: 403, reason: asked };

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, status: 404, reason: "not found" };
  }
  const resolved = refusal(real);
  if (resolved) return { ok: false, status: 403, reason: resolved, real };
  if (!realRoots(cfg.roots).some((root) => inside(real, root))) return { ok: false, status: 403, reason: "outside roots", real };

  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, status: 404, reason: "not found", real };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, status: 404, reason: "not a file", real };
    if (st.size > cfg.maxBytes) return { ok: false, status: 413, reason: "too large", real };
    const bytes = new Uint8Array(st.size);
    let got = 0;
    while (got < bytes.length) {
      const n = readSync(fd, bytes, got, bytes.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return { ok: true, bytes: bytes.subarray(0, got), name: basename(real), real };
  } finally {
    closeSync(fd);
  }
}
