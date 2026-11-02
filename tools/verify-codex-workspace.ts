// Reproducible host verification for ADR-0074. It never contacts production and creates only a
// disposable Git repository/worktree. Exit 77 means the current environment cannot nest Codex's
// Linux sandbox; rerun the printed command on a normal Linux host.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { codexBinaryPath } from "../src/engine/codex-mcp-bridge";
import { prepareCodexWorkspace } from "../src/engine/codex-workspace";

const dockerSocket = process.argv.find((arg) => arg.startsWith("--docker-socket="))?.slice("--docker-socket=".length);
if (process.argv.some((arg) => arg !== process.argv[0] && arg !== process.argv[1] && !arg.startsWith("--docker-socket="))) {
  console.error("usage: bun tools/verify-codex-workspace.ts [--docker-socket=/absolute/socket]");
  process.exit(64);
}

// `:workspace` explicitly includes the system temp directory. The outer Neo checkout is outside
// the disposable worktree and therefore makes a meaningful negative boundary check.
const root = mkdtempSync(join(process.cwd(), ".neo-codex-verify-"));
try {
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  git(root, ["init", repo]);
  git(repo, ["config", "user.name", "Neo verification"]);
  git(repo, ["config", "user.email", "neo-verification@example.invalid"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "seed.txt"]);
  git(repo, ["commit", "-m", "seed"]);
  git(repo, ["worktree", "add", "-b", "codex-verify", worktree]);
  writeFileSync(join(worktree, "changed.txt"), "changed\n");

  const policy = await prepareCodexWorkspace(worktree, dockerSocket);
  if (!policy.config) throw new Error("verification worktree did not produce a Codex permission profile");
  const codexHome = join(root, "codex-home");
  const script = join(worktree, "verify.sh");
  mkdirSync(codexHome, { mode: 0o700 });
  writeFileSync(join(codexHome, "config.toml"), profileToml(policy.config));
  writeFileSync(script, `#!/bin/sh\nset -eu\ngit add changed.txt\ngit commit -m "sandbox index lock verification" >/dev/null\ngit diff --cached --quiet\n${dockerSocket ? "docker version --format '{{.Server.Version}}' >/dev/null" : ":"}\n`);
  chmodSync(script, 0o700);

  const result = spawnSync(codexBinaryPath(), ["sandbox", "-C", worktree, "-P", "neo-project", "--", "/bin/sh", script], {
    env: { ...process.env, CODEX_HOME: codexHome, ...(dockerSocket ? { DOCKER_HOST: policy.env.DOCKER_HOST, DOCKER_CONTEXT: "" } : {}) },
    encoding: "utf8",
  });
  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/bwrap:.*(?:NETLINK_ROUTE.*Operation not permitted|Failed to create NETLINK_ROUTE socket)/is.test(diagnostic)) {
    console.error("SKIP (77): this managed environment cannot nest the Codex Linux sandbox. Rerun this command on the target host.");
    process.exitCode = 77;
  } else if (result.status !== 0) {
    throw new Error(`Codex sandbox verification failed without completing Git/Docker checks: ${diagnostic.slice(0, 2000)}`);
  } else {
    const committed = git(worktree, ["log", "-1", "--format=%s"]).trim();
    if (committed !== "sandbox index lock verification") throw new Error("sandbox Git commit did not complete");
    const sibling = join(root, "sibling-write-must-fail");
    const denyScript = join(worktree, "deny-sibling-write.sh");
    writeFileSync(denyScript, `#!/bin/sh\nset -eu\nprintf forbidden > '${sibling}'\n`);
    chmodSync(denyScript, 0o700);
    const denied = spawnSync(codexBinaryPath(), ["sandbox", "-C", worktree, "-P", "neo-project", "--", "/bin/sh", denyScript], {
      env: { ...process.env, CODEX_HOME: codexHome }, encoding: "utf8",
    });
    if (denied.status === 0) throw new Error("Codex profile unexpectedly wrote outside the disposable worktree");
    console.log(`PASS: normal Git index lock transaction succeeded in a Codex sandbox${dockerSocket ? "; configured Docker socket query succeeded" : ""}.`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function profileToml(config: Record<string, unknown>): string {
  const lines = [
    `default_permissions = ${JSON.stringify(config.default_permissions)}`,
    "[features]",
    `network_proxy = ${config.features && typeof config.features === "object" && (config.features as Record<string, unknown>).network_proxy === true}`,
    "[permissions.neo-project]",
    `extends = ${JSON.stringify(config["permissions.neo-project.extends"])}`,
    "[permissions.neo-project.filesystem]",
  ];
  for (const [key, value] of Object.entries(config).filter(([key]) => key.startsWith("permissions.neo-project.filesystem."))) {
    lines.push(`${key.slice("permissions.neo-project.filesystem.".length)} = ${JSON.stringify(value)}`);
  }
  if (config["permissions.neo-project.network.enabled"] === true) {
    lines.push("[permissions.neo-project.network]", "enabled = true", "[permissions.neo-project.network.unix_sockets]");
    for (const [key, value] of Object.entries(config).filter(([key]) => key.startsWith("permissions.neo-project.network.unix_sockets."))) {
      lines.push(`${key.slice("permissions.neo-project.network.unix_sockets.".length)} = ${JSON.stringify(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
