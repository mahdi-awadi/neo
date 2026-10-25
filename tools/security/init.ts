// Turn the security checks on for one repo (ADR-0024): git hooks for pre-commit and pre-push, the
// project's .security/config.json, a baseline of today's findings, and .gitignore lines for the
// reports. A hook that was already there is chained (it still runs after ours), never replaced. With
// husky, the scan line goes into .husky/<hook>, because husky resets core.hooksPath on every install.
// Running it again changes nothing.
//
//   bun ~/.claude/security/init.ts <repo> [--no-baseline]
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const HOOKS = { "pre-commit": "staged", "pre-push": "push" } as const;
type Hook = keyof typeof HOOKS;
/** Marks every line or file this tool writes, so a rerun finds its own work. */
const MARK = "neo-security";
const KIT_DIR = "${NEO_SECURITY_KIT:-$HOME/.claude/security}";
const DEFAULT_CONFIG = { devUrls: [], images: [], testCmd: "" };
const IGNORE = [".security/reports/", ".security/sbom/"];

function git(repo: string, ...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", repo, ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
}

/** Our .githooks script: scan, then run the hook that was there before (`prev`: repo-relative, or
 *  absolute for a global or worktree hooks folder). */
function hookScript(hook: Hook, prev: string | undefined): string {
  const pushInput = hook === "pre-push"; // pre-push gets the refs on stdin; the chained hook needs them too
  const scan =
    hook === "pre-push"
      ? [
          // Scan exactly the commits being pushed and not yet on any remote. Deleting a ref pushes none.
          'shas=""; while read -r _ lsha _ _; do [[ -n "$lsha" && ! "$lsha" =~ ^0+$ ]] && shas="${shas:+$shas }$lsha"; done <<<"$input"',
          'if [[ -n "$shas" ]]; then bash "$kit/scan.sh" push "$repo" "$shas --not --remotes" || exit 1; fi',
        ]
      : [`bash "$kit/scan.sh" ${HOOKS[hook]} "$repo" || exit 1`];
  return [
    "#!/usr/bin/env bash",
    `# ${MARK}: Neo security checks (tools/security, ADR-0024). Recreate with: bun ~/.claude/security/init.ts <repo>`,
    `# chained: ${prev ?? "none"}`,
    `kit="${KIT_DIR}"`,
    'repo="$(git rev-parse --show-toplevel)"',
    ...(pushInput ? ['input="$(cat)"'] : []),
    'if [[ -f "$kit/scan.sh" ]]; then',
    ...scan.map((l) => `  ${l}`),
    "else",
    '  echo "[security] warn: security kit not installed at $kit — scan skipped" >&2',
    "fi",
    // A recorded chained hook that cannot run fails closed (ADR-0051): skipping it would silently
    // drop the project's own checks.
    ...(prev
      ? [
          `prev="${isAbsolute(prev) ? prev : `$repo/${prev}`}"`,
          'if [[ ! -f "$prev" || ! -x "$prev" ]]; then',
          `  echo "[security] BLOCK: the chained hook $prev is missing or not executable — restore it (commit it), or re-run: bun ~/.claude/security/init.ts \\"$repo\\"" >&2`,
          "  exit 1",
          "fi",
          `exec "$prev" "$@"${pushInput ? ' <<<"$input"' : ""}`,
        ]
      : []),
    "exit 0",
    "",
  ].join("\n");
}

/** The repo-relative hook to chain behind ours, if any. */
function previousHook(repo: string, hook: Hook, hooksPath: string): string | undefined {
  const ours = join(repo, ".githooks", hook);
  if (existsSync(ours)) {
    const body = readFileSync(ours, "utf8");
    if (body.includes(MARK)) {
      const chained = body.match(/^# chained: (.+)$/m)?.[1];
      if (!chained || chained === "none") return undefined;
      // A recorded chain that still exists is kept; one that is gone is re-detected (ADR-0051).
      if (existsSync(resolve(repo, chained))) return chained;
    } else {
      renameSync(ours, `${ours}.pre-neo`); // a project hook already in .githooks: keep it, chained
      return `.githooks/${hook}.pre-neo`;
    }
  }
  // core.hooksPath may be global and absolute; --git-path is absolute in a worktree. resolve() takes both.
  if (hooksPath && hooksPath !== ".githooks") return existsSync(resolve(repo, hooksPath, hook)) ? join(hooksPath, hook) : undefined;
  const legacy = git(repo, "rev-parse", "--git-path", `hooks/${hook}`).out;
  // Once core.hooksPath is .githooks, --git-path names our own hook: never chain to it.
  return legacy && resolve(repo, legacy) !== ours && existsSync(resolve(repo, legacy)) ? legacy : undefined;
}

function installGithooks(repo: string, hooksPath: string): void {
  mkdirSync(join(repo, ".githooks"), { recursive: true });
  for (const hook of Object.keys(HOOKS) as Hook[]) {
    const path = join(repo, ".githooks", hook);
    writeFileSync(path, hookScript(hook, previousHook(repo, hook, hooksPath)));
    chmodSync(path, 0o755);
  }
  git(repo, "config", "core.hooksPath", ".githooks");
}

function installHusky(repo: string): void {
  for (const hook of Object.keys(HOOKS) as Hook[]) {
    const path = join(repo, ".husky", hook);
    const body = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (body.includes(MARK)) continue;
    // husky runs hooks with `sh -e`: without the kit (a fresh clone) the line must pass, not fail.
    const line = `kit="${KIT_DIR}"; [ ! -f "$kit/scan.sh" ] || bash "$kit/scan.sh" ${HOOKS[hook]} "$(git rev-parse --show-toplevel)" # ${MARK}\n`;
    writeFileSync(path, body && !body.endsWith("\n") ? `${body}\n${line}` : body + line);
    chmodSync(path, 0o755);
  }
}

export function initRepo(repo: string, opts: { baseline: (repo: string) => void }): { hooks: "githooks" | "husky" } {
  const top = git(repo, "rev-parse", "--show-toplevel");
  if (!top.ok) throw new Error(`${repo} is not a git repository`);
  const root = top.out;
  const hooksPath = git(root, "config", "core.hooksPath").out;
  const husky = hooksPath.startsWith(".husky");
  if (husky) installHusky(root);
  else installGithooks(root, hooksPath);

  mkdirSync(join(root, ".security"), { recursive: true });
  const config = join(root, ".security", "config.json");
  if (!existsSync(config)) writeFileSync(config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);

  const gi = join(root, ".gitignore");
  const lines = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const missing = IGNORE.filter((l) => !lines.split("\n").includes(l));
  if (missing.length) writeFileSync(gi, `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);

  if (!existsSync(join(root, ".security", "baseline.json"))) opts.baseline(root);
  return { hooks: husky ? "husky" : "githooks" };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const res = initRepo(repo, {
    baseline: (root) => {
      if (args.includes("--no-baseline")) return;
      console.log("[security] recording the baseline (a full scan; this takes a few minutes)…");
      Bun.spawnSync(["bash", join(import.meta.dir, "scan.sh"), "baseline", root], { stdout: "inherit", stderr: "inherit" });
    },
  });
  console.log(`[security] ${repo}: hooks via ${res.hooks}; config, gitignore and baseline in place`);
}
