import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { codexPermissionProfile, createCodexIgnoreUserConfigWrapper, gitMetadataDirectories, prepareCodexWorkspace } from "../src/engine/codex-workspace";

const made: string[] = [];
afterEach(() => made.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function scratch(prefix = "neo-codex-workspace-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  made.push(path);
  return path;
}

// Some concurrent test files temporarily replace and remove TMPDIR. Unix-domain sockets need a
// stable parent for the duration of an asynchronous listen, so this fixture uses the POSIX system
// temporary root rather than mutable process-wide test state.
function socketScratch(): string {
  const path = mkdtempSync("/tmp/neo-codex-socket-");
  made.push(path);
  return path;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function linkedWorktree(): { repo: string; worktree: string } {
  const repo = scratch();
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Neo test"]);
  git(repo, ["config", "user.email", "neo-test@example.invalid"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "seed.txt"]);
  git(repo, ["commit", "-m", "seed"]);
  const worktree = join(scratch("neo-codex-linked-"), "worktree");
  git(repo, ["worktree", "add", "-b", "codex-test", worktree]);
  return { repo, worktree };
}

test("linked worktree profile permits only its resolved Git metadata directories", () => {
  const { repo, worktree } = linkedWorktree();
  const dirs = gitMetadataDirectories(worktree);
  expect(dirs).toEqual([
    realpathSync(join(repo, ".git")),
    realpathSync(join(repo, ".git", "worktrees", "worktree")),
  ]);
  // `git add` performs Git's normal index.lock transaction in the external worktree git-dir.
  writeFileSync(join(worktree, "changed.txt"), "changed\n");
  git(worktree, ["add", "changed.txt"]);
  expect(git(worktree, ["diff", "--cached", "--name-only"])).toBe("changed.txt\n");
});

test("an ordinary checkout explicitly permits its .git metadata", async () => {
  const { repo } = linkedWorktree();
  const workspace = await prepareCodexWorkspace(repo);
  expect(workspace.config).toMatchObject({
    default_permissions: "neo-project",
    "permissions.neo-project.extends": ":workspace",
    [`permissions.neo-project.filesystem.${JSON.stringify(realpathSync(join(repo, ".git")))}`]: "write",
  });
});

test("Docker is disabled by default and an invalid configured socket fails closed", async () => {
  const workspace = await prepareCodexWorkspace(scratch());
  expect(workspace.config).toBeUndefined();
  expect(workspace.env).toEqual({});
  await expect(prepareCodexWorkspace(scratch(), join(tmpdir(), "neo-no-such-docker.sock"))).rejects.toThrow("inaccessible or not a Unix socket");
});

test("an opted-in real Unix socket is canonicalized and only it is granted", async () => {
  const folder = socketScratch();
  const socket = join(folder, "docker.sock");
  const alias = join(folder, "docker-alias.sock");
  mkdirSync(folder, { recursive: true });
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
  } catch (error) {
    // The managed Codex sandbox forbids creating Unix-domain listeners (EPERM). This host-level
    // restriction cannot exercise a real socket; normal development/target hosts still do.
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }
  symlinkSync(socket, alias);
  try {
    const workspace = await prepareCodexWorkspace(folder, alias);
    const canonical = realpathSync(socket);
    expect(workspace.env).toEqual({ DOCKER_HOST: `unix://${canonical}`, DOCKER_CONTEXT: "" });
    expect(workspace.config).toMatchObject({
      "permissions.neo-project.network.enabled": true,
      [`permissions.neo-project.network.unix_sockets.${JSON.stringify(canonical)}`]: "allow",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("an opted-in Docker workflow enables direct network and specifies its canonical socket", () => {
  const socket = "/run/docker sockets/dev.sock";
  expect(codexPermissionProfile(["/project/.git", "/project/.git/worktrees/task"], socket)).toMatchObject({
    "permissions.neo-project.network.enabled": true,
    features: { network_proxy: false },
    [`permissions.neo-project.network.unix_sockets.${JSON.stringify(socket)}`]: "allow",
    [`permissions.neo-project.filesystem.${JSON.stringify("/project/.git")}`]: "write",
    [`permissions.neo-project.filesystem.${JSON.stringify("/project/.git/worktrees/task")}`]: "write",
  });
});

test("the private launcher injects --ignore-user-config and is removed after its one turn", async () => {
  const parent = scratch("neo-codex-launchers-");
  const binary = join(parent, "fake-codex");
  const observed = join(parent, "arguments");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "${"$"}@" > '${observed}'\n`);
  chmodSync(binary, 0o700);
  const previous = process.env.NEO_CODEX_LAUNCHER_DIR;
  process.env.NEO_CODEX_LAUNCHER_DIR = parent;
  try {
    const wrapper = createCodexIgnoreUserConfigWrapper(binary);
    expect(statSync(wrapper.path).mode & 0o777).toBe(0o700);
    expect(spawnSync(wrapper.path, ["wrong"], { encoding: "utf8" }).status).toBe(64);
    expect(spawnSync(wrapper.path, ["exec", "--sandbox", "read-only"], { encoding: "utf8" }).status).toBe(0);
    expect(readFileSync(observed, "utf8").trim().split("\n")).toEqual(["exec", "--ignore-user-config", "--sandbox", "read-only"]);
    const directory = join(wrapper.path, "..");
    await wrapper.close();
    expect(existsSync(directory)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.NEO_CODEX_LAUNCHER_DIR;
    else process.env.NEO_CODEX_LAUNCHER_DIR = previous;
  }
});

test("launcher sends dotted Git paths as one TOML table rather than split SDK override keys", async () => {
  const parent = scratch("neo-codex-launchers-");
  const binary = join(parent, "fake-codex");
  const observed = join(parent, "arguments");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "${"$"}@" > '${observed}'\n`);
  chmodSync(binary, 0o700);
  const previous = process.env.NEO_CODEX_LAUNCHER_DIR;
  process.env.NEO_CODEX_LAUNCHER_DIR = parent;
  try {
    const config = codexPermissionProfile(["/repo/.git", "/repo/.git/worktrees/my.task"], "/run/docker.sock");
    const wrapper = createCodexIgnoreUserConfigWrapper(binary, config);
    expect(spawnSync(wrapper.path, ["exec"], { encoding: "utf8" }).status).toBe(0);
    const args = readFileSync(observed, "utf8").trim().split("\n");
    expect(args).toContain('permissions.neo-project.filesystem={"/repo/.git"="write","/repo/.git/worktrees/my.task"="write"}');
    expect(args).toContain('permissions.neo-project.network.unix_sockets={"/run/docker.sock"="allow"}');
    await wrapper.close();
  } finally {
    if (previous === undefined) delete process.env.NEO_CODEX_LAUNCHER_DIR;
    else process.env.NEO_CODEX_LAUNCHER_DIR = previous;
  }
});
