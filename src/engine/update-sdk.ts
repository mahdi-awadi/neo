// The `sdk` update source (ADR-0009): keeps the worker Agent SDK pin on the latest exact version.
// It NEVER touches the live checkout or its node_modules — a worker reads the SDK at launch, so a
// live install would mix versions until a restart. Instead it bumps the pin on a fresh branch in its
// own git worktree, runs `bunx tsc --noEmit` + `bun test`, and only when both are green
// fast-forwards the base branch. The running daemon keeps its SDK until the operator restarts it.
import type { ItemResult, RunContext, UpdateSource, UpdateSys } from "./updater";
import { breakingLines, compareVersions, notesBetween } from "./updater";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const REGISTRY_LATEST = `https://registry.npmjs.org/${SDK_PACKAGE}/latest`;
const CHANGELOG_URL = "https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md";
/** The model ids a bundle names — the bundle is the source of truth for which models exist. */
const MODEL_ID_PATTERN = "claude-(opus|sonnet|haiku|fable)-[0-9][a-z0-9.-]*";
const OUTPUT_TAIL_LINES = 30;

const MIN = 60_000;
const TIMEOUTS = { git: 2 * MIN, install: 5 * MIN, tsc: 10 * MIN, test: 20 * MIN };

export interface SdkSourceDeps {
  sys: UpdateSys;
  /** The engine's own repo (the live checkout — only git runs here). */
  repo: string;
  /** The branch a green bump fast-forwards (the repo convention: local `master`). */
  baseBranch: string;
}

const tail = (s: string) => s.trim().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");

export function sdkSource(d: SdkSourceDeps): UpdateSource {
  const { sys, repo, baseBranch } = d;
  const git = (args: string[], cwd = repo) => sys.exec(["git", ...args], { cwd, timeoutMs: TIMEOUTS.git });

  /** The pin on the base branch (not the working tree: the live checkout may be on another branch). */
  const currentPin = async (): Promise<string | undefined> => {
    const r = await git(["show", `${baseBranch}:package.json`]);
    if (r.code !== 0) return undefined;
    try {
      return (JSON.parse(r.out) as { dependencies?: Record<string, string> }).dependencies?.[SDK_PACKAGE];
    } catch {
      return undefined;
    }
  };

  const latestVersion = async (): Promise<string | undefined> => {
    const body = await sys.fetchText(REGISTRY_LATEST);
    try {
      return body ? (JSON.parse(body) as { version?: string }).version : undefined;
    } catch {
      return undefined;
    }
  };

  const modelIds = async (cwd: string): Promise<string[]> => {
    const r = await sys.exec(["grep", "-rhoE", MODEL_ID_PATTERN, `node_modules/${SDK_PACKAGE}`], { cwd, timeoutMs: TIMEOUTS.git });
    return [...new Set(r.out.split("\n").map((l) => l.trim()).filter(Boolean))].sort();
  };

  /** Where the base branch is checked out, if anywhere (then it is merged there, not ref-updated). */
  const baseWorktree = async (): Promise<string | undefined> => {
    const r = await git(["worktree", "list", "--porcelain"]);
    let path: string | undefined;
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      if (line === `branch refs/heads/${baseBranch}`) return path;
    }
    return undefined;
  };

  /** Bump the pin from → to on a branch, gate on tsc + tests, fast-forward the base branch. */
  const bump = async (from: string, to: string, why: string): Promise<ItemResult> => {
    const base: Omit<ItemResult, "outcome"> = { category: "sdk", id: SDK_PACKAGE, from, to };
    const branch = `chore/agent-sdk-${to}`;
    const wt = `${repo}-wt-sdk-${to}`;
    // A crash may have left either behind; start clean (errors here just mean "nothing to clean").
    await git(["worktree", "remove", "--force", wt]);
    await git(["branch", "-D", branch]);
    const cleanup = async (keepBranch: boolean) => {
      await git(["worktree", "remove", "--force", wt]);
      if (!keepBranch) await git(["branch", "-D", branch]);
    };
    const fail = async (step: string, r: { out: string; err: string }, keepBranch = false): Promise<ItemResult> => {
      await cleanup(keepBranch);
      return { ...base, outcome: "failed", detail: `${step} failed — not merged:\n${tail(`${r.out}\n${r.err}`)}` };
    };

    const add = await git(["worktree", "add", "-b", branch, wt, baseBranch]);
    if (add.code !== 0) return fail("git worktree add", add);
    const install = await sys.exec(["bun", "add", "--exact", `${SDK_PACKAGE}@${to}`], { cwd: wt, timeoutMs: TIMEOUTS.install });
    if (install.code !== 0) return fail("bun add", install);
    const tsc = await sys.exec(["bunx", "tsc", "--noEmit"], { cwd: wt, timeoutMs: TIMEOUTS.tsc });
    if (tsc.code !== 0) return fail("bunx tsc --noEmit", tsc);
    const tests = await sys.exec(["bun", "test"], { cwd: wt, timeoutMs: TIMEOUTS.test });
    if (tests.code !== 0) return fail("bun test", tests);
    // `bun test` prints its summary on stderr.
    const passLine = `${tests.out}\n${tests.err}`.split("\n").find((l) => /^\s*\d+ pass/.test(l))?.trim();

    const [oldIds, newIds] = [await modelIds(repo), await modelIds(wt)];
    const added = newIds.filter((m) => !oldIds.includes(m));

    await git(["add", "package.json", "bun.lock"], wt);
    // Made by the engine, not a model — so no Co-Authored-By trailer (CLAUDE.md: name the real author).
    const commit = await git(["commit", "-m", `chore(deps): pin ${SDK_PACKAGE} ${from} → ${to}`, "-m", `${why} (ADR-0009): bunx tsc --noEmit and bun test green${passLine ? ` (${passLine})` : ""}.`], wt);
    if (commit.code !== 0) return fail("git commit", commit);

    const where = await baseWorktree();
    let merge;
    if (where) {
      const dirty = await git(["status", "--porcelain"], where);
      if (dirty.out.trim()) return fail(`merge (${baseBranch} is checked out in ${where} with uncommitted changes; branch ${branch} kept)`, dirty, true);
      merge = await git(["merge", "--ff-only", branch], where);
    } else {
      merge = await git(["fetch", ".", `${branch}:${baseBranch}`]);
    }
    if (merge.code !== 0) return fail(`fast-forward of ${baseBranch} (branch ${branch} kept)`, merge, true);
    await cleanup(false);
    const models = added.length ? `new model ids: ${added.join(", ")}` : `model ids: ${newIds.join(", ") || "none found"}`;
    return {
      ...base,
      outcome: "merged",
      restartNeeded: true,
      detail: `green${passLine ? ` (${passLine})` : ""}, ${baseBranch} fast-forwarded; ${models}; run \`bun install\` in the live checkout at restart`,
    };
  };

  return {
    category: "sdk",
    async run(ctx: RunContext) {
      if (ctx.only && ctx.only !== SDK_PACKAGE && ctx.only !== "sdk") return [];
      const from = await currentPin();
      const to = await latestVersion();
      const base: Omit<ItemResult, "outcome"> = { category: "sdk", id: SDK_PACKAGE, from, to };
      if (!from || !to) return [{ ...base, outcome: "failed", detail: !from ? `no exact pin for ${SDK_PACKAGE} on ${baseBranch}` : "npm registry unreachable" }];
      if (compareVersions(to, from) <= 0) return [{ ...base, to: undefined, outcome: "up_to_date" }];
      const last = ctx.lastResult(SDK_PACKAGE);
      if (!ctx.force && last?.outcome === "failed" && last.to === to) {
        return [{ ...base, outcome: "skipped", detail: `${to} failed its checks before — waiting for a newer release (or /updates apply ${SDK_PACKAGE})` }];
      }
      const breaking = breakingLines(notesBetween((await sys.fetchText(CHANGELOG_URL)) ?? "", from, to));
      if (breaking.length && ctx.holdBreaking) return [{ ...base, outcome: "held", breaking, detail: `release notes flag a breaking change — /updates apply ${SDK_PACKAGE}` }];
      if (!ctx.autoApply) return [{ ...base, outcome: "available", breaking: breaking.length ? breaking : undefined, detail: "auto-apply is off for sdk" }];
      const r = await bump(from, to, "Automatic bump by Neo's updater");
      return [breaking.length ? { ...r, breaking } : r];
    },
    async rollback(last) {
      const current = (await currentPin()) ?? last.to ?? "";
      if (!last.from) return { category: "sdk", id: SDK_PACKAGE, outcome: "failed", detail: "no previous version recorded" };
      return bump(current, last.from, "Rollback by Neo's updater");
    },
  };
}
