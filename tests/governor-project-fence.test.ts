// ADR-0031: a dispatched (or loop) worker and its helper agents stay in their project. A write, a git
// branch or a commit in ANOTHER project root under the work root is a fenced escalation; ordinary
// out-of-folder writes (/tmp, caches, the worker's own memory, Neo's handoff notes) stay allowed
// under ADR-0012. 2026-10-10: a mirshad worker's subagents branched and wrote a plan in /home/eticket-v3.
import { test, expect } from "bun:test";
import { decide, type GovernorCtx } from "../src/engine/governor";
import { buildCanUseTool, buildGovernorHook, type RunHandlers } from "../src/engine/session-runner";
import { profileDeps } from "../src/engine/worker-profile";
import { briefWithProjectDocs, codebaseMemoryLine } from "../src/engine/dispatch";

const CTX: GovernorCtx = { folder: "/home/mirshad", outOfFolderWrites: "allow", projectFence: { root: "/home", allow: ["/home/neo/data/handoffs"] } };

test("a write into another project root escalates (fenced); its own folder and non-project paths are allowed", () => {
  const v = decide("Write", { file_path: "/home/eticket-v3/docs/superpowers/plans/kurdish.md", content: "x" }, CTX);
  expect(v).toMatchObject({ fenced: true });
  expect("escalate" in v && v.escalate).toContain("/home/eticket-v3");
  expect("escalate" in v && v.escalate).toContain("`project_notes`"); // ADR-0043
  expect(decide("Edit", { file_path: "/home/eticket-v3/src/a.ts" }, CTX)).toMatchObject({ fenced: true });
  expect(decide("NotebookEdit", { notebook_path: "/home/gold/n.ipynb" }, CTX)).toMatchObject({ fenced: true });
  expect(decide("Write", { file_path: "/home/mirshad/src/a.cs", content: "x" }, CTX)).toEqual({ allow: true });
  expect(decide("Write", { file_path: "/tmp/scratch/a.txt", content: "x" }, CTX)).toEqual({ allow: true });
  expect(decide("Edit", { file_path: "/root/.claude/projects/-home-mirshad/memory/x.md" }, CTX)).toEqual({ allow: true });
  expect(decide("Write", { file_path: "/home/neo/data/handoffs/-home-mirshad.md", content: "x" }, CTX)).toEqual({ allow: true });
  expect(decide("Write", { file_path: "/home/../home/eticket-v3/x", content: "x" }, CTX)).toMatchObject({ fenced: true }); // normalised
});

test("git writes in another project escalate: -C, cd into it, a worktree or branch there", () => {
  for (const command of [
    "git -C /home/eticket-v3 checkout -b feature/kurdish",
    "cd /home/eticket-v3 && git add -A && git commit -m 'kurdish'",
    "cd /home/eticket-v3; git switch -c kurdish",
    "git -C /home/eticket-v3 worktree add ../x",
    "git --git-dir=/home/eticket-v3/.git --work-tree=/home/eticket-v3 commit -am x",
  ]) {
    expect(decide("Bash", { command }, CTX)).toMatchObject({ fenced: true });
  }
});

test("shell writes into another project escalate; reading it, and writing at home, do not", () => {
  for (const command of [
    "echo hi > /home/eticket-v3/notes.md",
    "cat x >> /home/gold/a.txt",
    "cp plan.md /home/eticket-v3/docs/plan.md",
    "mkdir -p /home/eticket-v3/docs/kurdish",
    "tee /home/eticket-v3/x.txt < a",
    "sed -i 's/a/b/' /home/eticket-v3/src/a.ts",
  ]) {
    expect(decide("Bash", { command }, CTX)).toMatchObject({ fenced: true });
  }
  for (const command of [
    "git -C /home/eticket-v3 log --oneline -5",
    "cat /home/eticket-v3/README.md",
    "grep -rn Kurdish /home/eticket-v3/src",
    "git status && git commit -am 'mirshad fix'",
    "cd /home/mirshad/src && git commit -m x",
    "cp /home/eticket-v3/docs/a.md /tmp/a.md",
    "echo x > /tmp/out.txt",
  ]) {
    expect(decide("Bash", { command }, CTX)).toEqual({ allow: true });
  }
});

// Code review (2026-10-10): the shapes a confused worker actually uses.
test("review: subshells, sh -c / bash -c / eval, pipes, git option and env forms, pushd, env -C, ~ and relative paths", () => {
  for (const command of [
    "(cd /home/eticket-v3 && git commit -m x)",
    "sh -c 'cd /home/eticket-v3 && git commit -m x'",
    'bash -c "git -C /home/eticket-v3 commit -m x"',
    "eval 'git -C /home/eticket-v3 commit -m x'",
    "echo x | tee /home/eticket-v3/a",
    "git -c user.name=n -C /home/eticket-v3 commit -m x",
    "git --git-dir /home/eticket-v3/.git commit -m x",
    "GIT_DIR=/home/eticket-v3/.git git commit -m x",
    "GIT_WORK_TREE=/home/eticket-v3 git add .",
    "pushd /home/eticket-v3 && git commit -m x",
    "env -C /home/eticket-v3 git commit -m x",
    "cd ../eticket-v3 && git commit -m x",
    "git -C ../eticket-v3 checkout -b k",
    "cp -t /home/eticket-v3/docs plan.md",
  ]) {
    expect(decide("Bash", { command }, CTX)).toMatchObject({ fenced: true });
  }
});

test("review: a '>' inside quotes is text, and a worker's own sibling git worktree is its own project", () => {
  for (const command of [
    "git commit -m 'port fix -> /home/eticket-v3/x'",
    "echo '-> /home/eticket-v3'",
  ]) {
    expect(decide("Bash", { command }, CTX)).toEqual({ allow: true });
  }
  // /home/<repo>-wt-x is a worktree of the session's repo: its .git FILE points into <repo>/.git/worktrees.
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const home = mkdtempSync(join(require("node:os").tmpdir(), "fence-"));
  mkdirSync(join(home, "mirshad", ".git", "worktrees", "feat"), { recursive: true });
  mkdirSync(join(home, "mirshad-wt-feat"));
  writeFileSync(join(home, "mirshad-wt-feat", ".git"), `gitdir: ${join(home, "mirshad", ".git", "worktrees", "feat")}\n`);
  mkdirSync(join(home, "eticket-v3"));
  const ctx: GovernorCtx = { folder: join(home, "mirshad"), outOfFolderWrites: "allow", projectFence: { root: home, allow: [] } };
  expect(decide("Write", { file_path: join(home, "mirshad-wt-feat", "a.cs"), content: "x" }, ctx)).toEqual({ allow: true });
  expect(decide("Write", { file_path: join(home, "eticket-v3", "a.ts"), content: "x" }, ctx)).toMatchObject({ fenced: true });
  // a symlink inside the project that points at another project is still another project
  require("node:fs").symlinkSync(join(home, "eticket-v3"), join(home, "mirshad", "link"));
  expect(decide("Write", { file_path: join(home, "mirshad", "link", "x.ts"), content: "x" }, ctx)).toMatchObject({ fenced: true });
});

test("no fence (operator sessions, the company): behaviour is unchanged", () => {
  const ctx = { folder: "/home/mirshad", outOfFolderWrites: "allow" as const };
  expect(decide("Write", { file_path: "/home/eticket-v3/x.md", content: "x" }, ctx)).toEqual({ allow: true });
  expect(decide("Bash", { command: "git -C /home/eticket-v3 checkout -b x" }, ctx)).toEqual({ allow: true });
});

test("the fence reaches the SDK twice — canUseTool and the PreToolUse hook (which subagent calls re-enter)", async () => {
  const fence = CTX.projectFence!;
  const escalations: string[] = [];
  const handlers = { onMessage: () => {}, onEscalation: async (reason: string) => (escalations.push(reason), "deny" as const) } as unknown as RunHandlers;
  const can = buildCanUseTool(handlers, "/home/mirshad", "neo", "allow", fence);
  const r = (await can("Write", { file_path: "/home/eticket-v3/x.md", content: "x" })) as { behavior: string };
  expect(r.behavior).toBe("deny");
  expect(escalations[0]).toContain("/home/eticket-v3");
  const hook = buildGovernorHook("/home/mirshad", "allow", undefined, fence);
  const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/home/eticket-v3/a.ts" } } as never, undefined, { signal: new AbortController().signal });
  expect(out.hookSpecificOutput?.permissionDecision).toBe("ask");
});

test("profileDeps fences dispatch and loop workers only, with Neo's handoff notes allowed", () => {
  const cfg = { workers: {} as never, workerEnv: {}, workRoot: "/home", handoffNotesDir: "/home/neo/data/handoffs", governor: { outOfFolderWrites: "allow" as const, approvalRemindMs: 0, approvalTimeoutMs: 0 } };
  expect(profileDeps(cfg, "dispatch").projectFence).toEqual({ root: "/home", allow: ["/home/neo/data/handoffs"] });
  expect(profileDeps(cfg, "loop").projectFence).toEqual({ root: "/home", allow: ["/home/neo/data/handoffs"] });
  expect(profileDeps(cfg, "project").projectFence).toBeUndefined();
  expect(profileDeps(cfg, "company").projectFence).toBeUndefined();
});

test("the preamble tells workers (and their helpers) to send cross-project work as a project note, and stays terse", () => {
  const p = briefWithProjectDocs("");
  expect(p).toContain("another project");
  expect(p).toContain("helper");
  expect(p).toContain("`project_notes`"); // ADR-0043
  expect((codebaseMemoryLine({ project: "home-" + "x".repeat(80) }) + "\n\n" + p).length).toBeLessThan(5350) /* + the report rule (ADR-0073) */; // + the push rule (ADR-0069)
});
