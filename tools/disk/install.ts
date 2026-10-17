// Install the disk-cleanup kit for this host (ADR-0040), the way the security kit installs: copy it
// to a fixed place outside any checkout, so the loop runs the same code whatever branch /home/neo
// is on. The host's config.json and state/ are kept. Running it again only refreshes the code.
//
//   bun tools/disk/install.ts [--dest ~/.local/share/neo/disk]
import { cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Host-local files in the destination that a re-install must never overwrite. */
const HOST_LOCAL = new Set(["config.json", "state"]);

export const DEFAULT_DEST = join(homedir(), ".local", "share", "neo", "disk");

export function installDiskKit(opts: { src: string; dest: string }): { dest: string } {
  mkdirSync(opts.dest, { recursive: true });
  // force: Bun drops Node's default (overwrite) when a filter is given (see the security kit).
  cpSync(opts.src, opts.dest, { recursive: true, force: true, filter: (from) => from === opts.src || !HOST_LOCAL.has(basename(from)) });
  return { dest: opts.dest };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--dest");
  const { dest } = installDiskKit({ src: import.meta.dir, dest: at >= 0 ? args[at + 1]! : DEFAULT_DEST });
  console.log(`[disk] kit installed in ${dest}; run: bun ${dest}/cleanup.ts run --dry-run`);
}
