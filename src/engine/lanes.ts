// Side lanes (ADR-0057): small, independent todos run beside a project's main task. The chief of
// staff picks the lane and kind when it writes the brief; this module holds the rules the engine
// enforces with them — the kinds, the config, the start check and the governor's lane verdict.
import { isAbsolute, join, resolve, sep } from "node:path";
import { GIT_WRITE, gitCall, walkBash, writeTargets } from "./bash-walk";
import { tmpdir } from "node:os";

/** What a side-lane todo declares it does (CONTEXT.md "Lane kind"). */
export const LANE_KINDS = ["read-only", "ops", "test", "code"] as const;
export type LaneKind = (typeof LANE_KINDS)[number];

export function isLaneKind(x: unknown): x is LaneKind {
  return typeof x === "string" && (LANE_KINDS as readonly string[]).includes(x);
}

/** A todo's lane: the project's one main session, or a side lane of a declared kind. */
export type Lane = { lane: "main" } | { lane: "side"; kind: LaneKind };

/** A live side-lane session's marker (SessionInfo.lane). `projectFolder` is the project the lane
 *  belongs to — for `code` the session's own folder is its worktree. */
export interface SessionLane {
  kind: LaneKind;
  projectFolder: string;
  todoId?: number;
}

/** The `lanes` config block (docs/CONFIG.md). */
export interface LanesCfg {
  /** false → every brief goes to the queue, as before ADR-0057. */
  enabled: boolean;
  /** Side lanes one project may run at once. 0 = none. */
  maxSidePerProject: number;
  /** Dispatch runs (main and side) the host may run at once before a side lane waits. */
  maxDispatchesHost: number;
  /** Where `code` lanes get their temporary worktrees (absolute; outside the work root). */
  worktreeRoot: string;
  /** How a brief with no lane is placed. Only "none" (the queue) in v1; reserved for a classifier. */
  noLaneClassifier: "none";
}

export const DEFAULT_LANES_CFG: LanesCfg = {
  enabled: true,
  maxSidePerProject: 1,
  maxDispatchesHost: 3,
  worktreeRoot: join(tmpdir(), "neo-lanes"),
  noLaneClassifier: "none",
};

/** Parse the config value; a missing or bad field keeps its default. */
export function readLanesCfg(raw: unknown): LanesCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const count = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_LANES_CFG.enabled,
    maxSidePerProject: count(r.maxSidePerProject, 0) ? r.maxSidePerProject : DEFAULT_LANES_CFG.maxSidePerProject,
    maxDispatchesHost: count(r.maxDispatchesHost, 1) ? r.maxDispatchesHost : DEFAULT_LANES_CFG.maxDispatchesHost,
    worktreeRoot: typeof r.worktreeRoot === "string" && isAbsolute(r.worktreeRoot) ? r.worktreeRoot : DEFAULT_LANES_CFG.worktreeRoot,
    noLaneClassifier: "none",
  };
}

// ---- The governor's lane verdict ----------------------------------------------------------------

/** `docker …`/`docker compose …`/`docker-compose …` and `systemctl` subcommands that start, stop,
 *  rebuild or remove what a project runs on. A side lane never does these: the main task uses them. */
const CONTAINER_LIFECYCLE = /^(restart|stop|start|up|down|kill|rm|build|create|pause|unpause|reload)$/;
/** Flags of `docker`/`docker compose` that take a value (so the value is not the subcommand). */
const DOCKER_VALUE_FLAGS = new Set(["-f", "--file", "-p", "--project-name", "--env-file", "--profile", "-H", "--host", "--context", "-c", "--config"]);

/** The container/service lifecycle action a command takes, e.g. "docker compose restart". */
function lifecycleAction(words: string[]): string | undefined {
  let w = words[0] === "sudo" ? words.slice(1) : words;
  if (w[0] === "systemctl") {
    const sub = w.slice(1).find((x) => !x.startsWith("-"));
    return sub && CONTAINER_LIFECYCLE.test(sub) ? `systemctl ${sub}` : undefined;
  }
  let head: string;
  if (w[0] === "docker-compose") {
    head = "docker-compose";
    w = w.slice(1);
  } else if (w[0] === "docker") {
    head = "docker";
    w = w.slice(1);
  } else return undefined;
  for (let i = 0; i < w.length; i++) {
    const x = w[i]!;
    if (DOCKER_VALUE_FLAGS.has(x)) {
      i++;
      continue;
    }
    if (x.startsWith("-")) continue;
    if (x === "compose" || x === "container" || x === "service") {
      head += ` ${x}`;
      continue;
    }
    return CONTAINER_LIFECYCLE.test(x) ? `${head} ${x}` : undefined;
  }
  return undefined;
}

/** True when `p` (absolute) is `dir` or inside it. */
function within(p: string, dir: string): boolean {
  const d = resolve(dir);
  return p === d || p.startsWith(d + sep);
}

/** Why a side lane may not do this — the deny text — or undefined when the lane rules allow it (the
 *  normal governor rules still apply after). Shared-folder kinds (`read-only`, `ops`, `test`) never
 *  write the project's files, run a git write or touch container lifecycle; `read-only` writes only in
 *  the temp dir. `code` works only in its worktree (the session folder): never the main project folder,
 *  never another branch, never a push, never container lifecycle. ADR-0057. */
export function laneVerdict(tool: string, input: Record<string, unknown>, ctx: { folder: string; lane: SessionLane }): string | undefined {
  const { lane, folder } = ctx;
  const kind = lane.kind;
  const no = (what: string) =>
    `side lane (${kind}): ${what} is not allowed — a side lane must not interfere with the project's main task. ` +
    `Do what you can without it, then say in your result that this step needs the main lane, so the chief of staff can queue it with lane "queue".`;
  const temp = resolve(tmpdir());
  // May this lane write the file at absolute path `p`?
  const writable = (p: string): boolean => {
    if (p === "/dev/null" || p === "/dev/stdout" || p === "/dev/stderr") return true; // discarding output
    if (kind === "code") return !within(p, lane.projectFolder);
    if (kind === "read-only") return within(p, temp);
    return !within(p, lane.projectFolder);
  };

  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
    const raw = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
    const p = resolve(resolve(folder), typeof raw === "string" ? raw : "");
    return writable(p) ? undefined : no(`writing ${p}`);
  }
  if (tool !== "Bash") return undefined;
  const command = typeof input.command === "string" ? input.command : "";
  return walkBash(command, folder, (seg) => {
    const at = (p: string) => resolve(resolve(seg.cwd), p);
    for (const r of seg.redirects) if (!writable(at(r))) return no(`writing ${at(r)}`);
    const life = lifecycleAction(seg.words);
    if (life) return no(`\`${life}\` (it would restart or change containers or services the main task uses)`);
    const git = gitCall(seg);
    if (git) {
      if (kind !== "code") return GIT_WRITE.test(git.sub) ? no(`\`git ${git.sub}\` (git writes belong to the main lane)`) : undefined;
      if (within(git.repo, lane.projectFolder) && GIT_WRITE.test(git.sub)) return no(`\`git ${git.sub}\` in the main project folder`);
      if (git.sub === "push") return no("`git push`");
      if (git.sub === "switch") return no("`git switch` (stay on your side branch)");
      if (git.sub === "checkout" && !git.args.includes("--")) return no("`git checkout` of another branch (stay on your side branch; `git checkout -- <file>` is fine)");
      return undefined;
    }
    for (const p of writeTargets(seg)) if (!writable(at(p))) return no(`writing ${at(p)}`);
    return undefined;
  });
}

/** What a side-lane worker is told first (ADR-0057). The governor enforces the same rules; this lets
 *  the worker plan around them instead of discovering them by denial. */
export function lanePreamble(kind: LaneKind, project: string, wt?: { path: string; branch: string; base: string }): string {
  const head = `SIDE LANE (${kind}) — you run BESIDE ${project}'s main task, which owns its working tree, its branch and its containers. Do only this one brief, then end with your result.`;
  const rules: Record<LaneKind, string> = {
    "read-only": "Read and check only. Write no files except under the temp dir; no git writes; never start, stop, restart or rebuild containers or services.",
    ops: "Run commands against the running services (DB rows through `docker exec`, API calls, logs, status). Never edit the project's files, never run git writes, never start, stop, restart or rebuild containers or services.",
    test: "Run the tests or checks as the code is now. Never edit the project's files, never run git writes, never start, stop, restart or rebuild containers or services.",
    code: wt
      ? `Work only in your own git worktree ${wt.path} on branch ${wt.branch} (from ${wt.base}). Commit your change there. Never touch the main folder, never switch branches, never push, never start, stop, restart or rebuild containers. The engine removes the worktree when you end and queues a main-lane todo to merge ${wt.branch} into ${wt.base}.`
      : "Work only in your own git worktree.",
  };
  return `${head} ${rules[kind]} If the brief needs anything else, do what you can and say in your result that the rest needs the main lane (lane "queue").`;
}

/** Whether a side todo may start now (ADR-0057): `ok`; `wait` for a side slot (a cap or a hold), or
 *  `queue` — it cannot be a side lane at all here, so it goes to the main lane's queue. */
export function canStartSide(
  s: { sideRunning: number; hostRunning: number; codex: boolean; hold?: string },
  cfg: LanesCfg,
): { ok: true } | { wait: string } | { queue: string } {
  if (!cfg.enabled) return { queue: "side lanes are off (lanes.enabled)" };
  if (s.codex) return { queue: "side lanes need the Claude worker SDK's governor hook, and the worker SDK is Codex" };
  if (s.hold) return { wait: s.hold };
  if (s.sideRunning >= cfg.maxSidePerProject) {
    return { wait: `${cfg.maxSidePerProject} side lane${cfg.maxSidePerProject === 1 ? "" : "s"} already run${cfg.maxSidePerProject === 1 ? "s" : ""} in this project (lanes.maxSidePerProject)` };
  }
  if (s.hostRunning >= cfg.maxDispatchesHost) return { wait: `the host already has ${s.hostRunning} dispatch runs going (lanes.maxDispatchesHost ${cfg.maxDispatchesHost})` };
  return { ok: true };
}

/** The main-lane todo that merges a finished `code` side lane's branch (ADR-0057). */
export function mergeBrief(branch: string, base: string, todoId: number, title: string): string {
  return (
    `Merge branch \`${branch}\` into \`${base}\`. It holds the work of code side lane #${todoId} (${title}), done in a ` +
    `separate worktree while this project was busy. Review its commits (\`git log ${base}..${branch}\`), merge it, run the ` +
    `relevant tests, then delete the branch. If it conflicts with what changed on ${base} meanwhile, resolve it properly.`
  );
}

/** How the chief of staff picks a lane — the `dispatch` and `todo` tool descriptions carry it (ADR-0057). */
export const LANE_GUIDE =
  'Lanes: set `lane: "side"` with a `kind` for a SHORT task that does not edit the files, branch or containers the project\'s main task uses — ' +
  "it then runs at once BESIDE a busy project instead of waiting in its queue (or waits only for a free side slot). Kinds: " +
  "`ops` (DB rows, users, passwords, API calls, docker status), `test` (run a test or check on the code as it is), " +
  "`read-only` (look and report), `code` (a small change that needs no running stack — made in its own worktree on a side branch; the engine queues a main-lane todo to merge it). " +
  "The engine enforces the kind: a side lane that edits the project, runs git writes or restarts containers is denied. " +
  'Anything else, or when unsure: `lane: "queue"` (the default) — the brief waits its turn in the main lane.';

/** The refusal for `lane: "side"` without a valid kind, else undefined. */
export function laneArgError(lane: unknown, kind: unknown): string | undefined {
  if (lane !== "side") return undefined;
  return isLaneKind(kind) ? undefined : `lane "side" needs a \`kind\`: one of ${LANE_KINDS.map((k) => `"${k}"`).join(", ")}. Nothing was queued.`;
}
