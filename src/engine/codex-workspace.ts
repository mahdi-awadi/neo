// Exact Codex sandbox permissions for one writable worker turn. The profile is supplied as SDK
// config overrides, never written into the operator's Codex config (ADR-0074).
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { CodexOptions } from "@openai/codex-sdk";

export interface CodexWorkspace {
  /** Per-process Codex permission profile overrides. Undefined means ordinary workspace-write. */
  config?: NonNullable<CodexOptions["config"]>;
  /** Applied after the normal worker-env scrub; only a configured socket needs Docker client routing. */
  env: Record<string, string>;
}

export interface CodexLaunchWrapper {
  path: string;
  close(): Promise<void>;
}

/** Resolve Git's mutable metadata directories. Codex makes `.git` read-only even within the
 * workspace, so ordinary checkouts need an explicit exact-path permission too. */
export function gitMetadataDirectories(folder: string): string[] {
  let root: string;
  try {
    root = realpathSync(folder);
  } catch {
    return [];
  }
  const gitPath = (arg: "--git-dir" | "--git-common-dir"): string | undefined => {
    try {
      const out = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", arg], {
        encoding: "utf8",
        env: gitDiscoveryEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!out || !isAbsolute(out)) return undefined;
      const path = realpathSync(out);
      return statSync(path).isDirectory() ? path : undefined;
    } catch {
      return undefined;
    }
  };
  return [...new Set([gitPath("--git-dir"), gitPath("--git-common-dir")].filter((path): path is string => !!path))].sort();
}

/** The worker/daemon environment must not redirect Git discovery to an attacker-selected repo. */
function gitDiscoveryEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

/** Construct Codex's native permission profile. Git grants are exact. An explicit Docker opt-in
 * enables direct network access on Linux, including other reachable sockets; Docker itself already
 * grants daemon-level authority. `default_permissions` selects the profile for this process. */
export async function prepareCodexWorkspace(folder: string, dockerSocket?: string): Promise<CodexWorkspace> {
  const gitDirs = gitMetadataDirectories(folder);
  let socket: string | undefined;
  if (dockerSocket) {
    try {
      socket = realpathSync(dockerSocket);
      if (!statSync(socket).isSocket()) throw new Error("not a Unix socket");
      // This is a DAC preflight, not an authority escalation. A daemon that cannot read/write the
      // configured socket must fail before the worker starts rather than report a later Docker error.
      accessSync(socket, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error(`Configured Codex Docker socket is inaccessible or not a Unix socket (${dockerSocket})`);
    }
  }
  if (!gitDirs.length && !socket) return { env: {} };

  return { config: codexPermissionProfile(gitDirs, socket), env: socket ? { DOCKER_HOST: `unix://${socket}`, DOCKER_CONTEXT: "" } : {} };
}

/** Pure policy encoder: keeps all path serialization testable without a host Docker daemon. */
export function codexPermissionProfile(gitDirs: readonly string[], socket?: string): NonNullable<CodexOptions["config"]> {
  const profile = "neo-project";
  const config: NonNullable<CodexOptions["config"]> = {
    default_permissions: profile,
    // Linux's managed network proxy blocks direct Unix-socket connections, even for its socket
    // allowlist. An explicit Docker opt-in therefore uses direct networking. This also gives that
    // privileged worker access to other host-reachable sockets and network endpoints.
    features: { network_proxy: !socket },
    [`permissions.${profile}.extends`]: ":workspace",
  };
  for (const dir of gitDirs) config[`permissions.${profile}.filesystem.${JSON.stringify(dir)}`] = "write";
  if (socket) {
    config[`permissions.${profile}.network.enabled`] = true;
    config[`permissions.${profile}.network.unix_sockets.${JSON.stringify(socket)}`] = "allow";
  }
  return config;
}

/** The SDK version in Neo cannot pass `codex exec --ignore-user-config`. A tiny per-turn launcher
 * adds that supported flag before the SDK's arguments, so ambient legacy `sandbox_mode` cannot
 * override this profile. It is created outside the worker sandbox and removed after the turn. */
export function createCodexIgnoreUserConfigWrapper(binary: string, config?: NonNullable<CodexOptions["config"]>): CodexLaunchWrapper {
  // `:workspace` includes the system temp directory. Keep the executable beneath the daemon's
  // private cache instead, so another sandboxed worker cannot replace it before the SDK spawns.
  const parent = process.env.NEO_CODEX_LAUNCHER_DIR?.trim() || join(homedir(), ".cache", "neo", "codex-launchers");
  if (!isAbsolute(parent)) throw new Error("NEO_CODEX_LAUNCHER_DIR must be an absolute daemon-private path");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  if (!statSync(parent).isDirectory()) throw new Error("Codex launcher directory is not a directory");
  const directory = mkdtempSync(join(realpathSync(parent), "turn-"));
  const path = join(directory, "codex");
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  // The SDK flattens config keys at every dot, including dots inside quoted file names. Pass each
  // path map as a single TOML inline table so the CLI parses .git and .sock as literal keys.
  const tables = ["permissions.neo-project.filesystem", "permissions.neo-project.network.unix_sockets"];
  const overrides = tables.flatMap((table) => {
    const entries = Object.entries(config ?? {}).filter(([key]) => key.startsWith(`${table}.`));
    if (!entries.length) return [];
    const value = entries.map(([key, entry]) => `${key.slice(table.length + 1)}=${JSON.stringify(entry)}`).join(",");
    return ["-c", `${table}={${value}}`];
  });
  writeFileSync(path, `#!/bin/sh\nset -eu\n[ \"${"$"}1\" = exec ] || exit 64\nshift\nexec ${quote(binary)} exec --ignore-user-config ${overrides.map(quote).join(" ")} \"${"$"}@\"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return { path, close: async () => rmSync(directory, { recursive: true, force: true }) };
}
