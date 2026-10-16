// Install the security kit for every Claude Code session on this host (ADR-0024): copy the kit to
// ~/.claude/security, add its two hooks to ~/.claude/settings.json and the /security-scan command
// to ~/.claude/commands (named so it never shadows Claude Code's built-in /security-review). Running it again changes nothing. Other hooks and settings are kept.
//
//   bun tools/security/install.ts [--claude-dir ~/.claude] [--no-rules] [--host-env dev|prod]
//   (--no-rules: skip downloading the semgrep packs; the scans warn until update-rules.sh runs)
//   (--host-env: what this server is, written to <kit>/host.json; without it the file is kept, and
//    no file means prod. On a dev host the guard lets workers write secret files — ADR-0039.)
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type HostEnv, hostEnvAt } from "./guard";

type Json = Record<string, unknown>;
interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

/** The tools whose input names a path or command the guard checks for secret files. */
const GUARD_MATCHER = "Read|Edit|Write|MultiEdit|NotebookEdit|Bash|Grep|Glob";
const EDIT_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
/** The post-edit hook gives the scan time to finish; scan.sh itself stops at 60 s. */
const POST_EDIT_TIMEOUT_S = 90;
/** Our entries are recognised by their script, wherever the kit was installed. */
const OURS = /\/security\/hooks\/(guard|post-edit)\.sh$/;
/** Files in the source kit that are build notes or host-local state, not part of the installed kit
 *  (a stray host.json in the source must never overwrite the host's own setting). */
const NOT_INSTALLED = new Set(["WIP.md", "host.json"]);

const isOurs = (e: HookEntry) => e.hooks?.some((h) => OURS.test(h.command ?? "")) ?? false;

/** `settings` with the kit's hooks, pointing at `kit`. Pure; idempotent; our old entries are replaced. */
export function mergeHooks(settings: Json, kit: string): Json {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  const put = (event: string, entry: HookEntry) => {
    hooks[event] = [...(hooks[event] ?? []).filter((e) => !isOurs(e)), entry];
  };
  put("PreToolUse", { matcher: GUARD_MATCHER, hooks: [{ type: "command", command: `bash ${kit}/hooks/guard.sh` }] });
  put("PostToolUse", { matcher: EDIT_MATCHER, hooks: [{ type: "command", command: `bash ${kit}/hooks/post-edit.sh`, timeout: POST_EDIT_TIMEOUT_S }] });
  return { ...settings, hooks };
}

/** Copy the kit and update settings + the command. Throws (and writes nothing) on a broken settings.json. */
export function installKit(opts: { src: string; claudeDir: string; hostEnv?: HostEnv }): { dest: string; settingsChanged: boolean; hostEnv: HostEnv } {
  if (opts.hostEnv !== undefined && opts.hostEnv !== "dev" && opts.hostEnv !== "prod")
    throw new Error(`--host-env must be dev or prod, not "${opts.hostEnv}" (nothing was changed)`);
  const settingsPath = join(opts.claudeDir, "settings.json");
  const before = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}";
  let settings: Json;
  try {
    settings = JSON.parse(before) as Json;
  } catch {
    throw new Error(`${settingsPath} is not valid JSON — fix it, then run the install again (nothing was changed)`);
  }

  const dest = join(opts.claudeDir, "security");
  mkdirSync(dest, { recursive: true });
  cpSync(opts.src, dest, { recursive: true, filter: (from) => !NOT_INSTALLED.has(basename(from)) });
  const hostFile = join(dest, "host.json");
  if (opts.hostEnv) writeFileSync(hostFile, `${JSON.stringify({ hostEnv: opts.hostEnv })}\n`);
  const command = join(opts.src, "security-scan.md");
  if (existsSync(command)) {
    mkdirSync(join(opts.claudeDir, "commands"), { recursive: true });
    cpSync(command, join(opts.claudeDir, "commands", "security-scan.md"));
  }

  const after = `${JSON.stringify(mergeHooks(settings, dest), null, 2)}\n`;
  const settingsChanged = JSON.stringify(JSON.parse(after)) !== JSON.stringify(settings);
  if (settingsChanged) {
    const tmp = `${settingsPath}.tmp-${process.pid}`;
    writeFileSync(tmp, after);
    renameSync(tmp, settingsPath); // atomic: a crash never leaves half a settings file
  }
  return { dest, settingsChanged, hostEnv: hostEnvAt(hostFile) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--claude-dir");
  const claudeDir = at >= 0 ? args[at + 1]! : join(homedir(), ".claude");
  const he = args.findIndex((a) => a === "--host-env" || a.startsWith("--host-env="));
  const heValue = he < 0 ? undefined : args[he]!.includes("=") ? args[he]!.slice("--host-env=".length) : (args[he + 1] ?? "");
  const { dest, settingsChanged, hostEnv } = installKit({ src: import.meta.dir, claudeDir, hostEnv: heValue as HostEnv | undefined });
  console.log(`[security] kit installed in ${dest}; settings ${settingsChanged ? "updated" : "already current"}; host env ${hostEnv}`);
  if (!args.includes("--no-rules")) {
    const r = Bun.spawnSync(["bash", join(dest, "update-rules.sh")], { stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) console.error("[security] warn: update-rules.sh failed; scans warn until it succeeds");
  }
}
