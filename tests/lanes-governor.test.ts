// ADR-0057: the governor keeps a side lane out of the main lane's way. A forbidden action is DENIED
// (never escalated) with a message that names the lane rule; allowed work follows the normal rules.
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type GovernorCtx } from "../src/engine/governor";
import type { LaneKind } from "../src/engine/lanes";

const P = "/home/p";
const FENCE = { root: "/home" };
const WT = join(tmpdir(), "neo-lanes", "p-side-8");
const shared = (kind: LaneKind): GovernorCtx => ({ folder: P, outOfFolderWrites: "allow", projectFence: FENCE, lane: { kind, projectFolder: P, todoId: 7 } });
const code: GovernorCtx = { folder: WT, outOfFolderWrites: "allow", projectFence: FENCE, lane: { kind: "code", projectFolder: P, todoId: 8 } };
const bash = (command: string) => ({ command });

const denied = (v: ReturnType<typeof decide>, kind: string) => {
  expect("deny" in v, JSON.stringify(v)).toBe(true);
  const msg = (v as { deny: string }).deny;
  expect(msg).toContain(`side lane (${kind})`);
  expect(msg).toContain('lane "queue"');
};

for (const kind of ["read-only", "ops", "test"] as const) {
  test(`${kind}: no file edits in the project folder`, () => {
    denied(decide("Edit", { file_path: `${P}/src/a.ts` }, shared(kind)), kind);
    denied(decide("Write", { file_path: "src/new.ts" }, shared(kind)), kind); // relative = in the folder
    denied(decide("NotebookEdit", { notebook_path: `${P}/n.ipynb` }, shared(kind)), kind);
  });
  test(`${kind}: no shell writes, git writes or container lifecycle in the project`, () => {
    denied(decide("Bash", bash("echo x > src/a.ts"), shared(kind)), kind);
    denied(decide("Bash", bash(`sed -i 's/a/b/' ${P}/x.go`), shared(kind)), kind);
    denied(decide("Bash", bash("git commit -am wip"), shared(kind)), kind);
    denied(decide("Bash", bash(`git -C ${P} reset --hard`), shared(kind)), kind);
    denied(decide("Bash", bash("git checkout main"), shared(kind)), kind);
    denied(decide("Bash", bash("docker compose restart api"), shared(kind)), kind);
    denied(decide("Bash", bash("docker compose -f dev.yml up -d"), shared(kind)), kind);
    denied(decide("Bash", bash("docker restart eticket-api"), shared(kind)), kind);
    denied(decide("Bash", bash("docker-compose down"), shared(kind)), kind);
    denied(decide("Bash", bash("sudo systemctl restart nginx"), shared(kind)), kind);
    denied(decide("Bash", bash("cd /tmp && sh -c 'git -C /home/p stash'"), shared(kind)), kind);
  });
  test(`${kind}: reads, checks, docker exec and tests are allowed`, () => {
    for (const c of ["docker ps", "docker compose logs --tail 50 api", "docker exec db psql -c 'select 1'", "git status", "git log -5", "git diff", "bun test tests/a.test.ts", "curl -s localhost:8080/health | head"]) {
      const v = decide("Bash", bash(c), shared(kind));
      expect("deny" in v, c).toBe(false);
    }
    expect(decide("Read", { file_path: `${P}/a.ts` }, shared(kind))).toEqual({ allow: true });
  });
}

test("ops and test may write outside the project (a temp file); read-only only in the temp dir", () => {
  expect(decide("Write", { file_path: join(tmpdir(), "out.json") }, shared("ops"))).toEqual({ allow: true });
  expect(decide("Write", { file_path: join(tmpdir(), "out.json") }, shared("read-only"))).toEqual({ allow: true });
  denied(decide("Write", { file_path: "/home/other/notes.md" }, shared("read-only")), "read-only");
  expect("deny" in decide("Bash", bash(`echo x > ${tmpdir()}/x.txt`), shared("read-only"))).toBe(false);
  denied(decide("Bash", bash("touch /var/log/x"), shared("read-only")), "read-only");
});

test("code: edits and commits in its own worktree; never the main folder, another branch or a push", () => {
  expect(decide("Edit", { file_path: `${WT}/src/a.ts` }, code)).toEqual({ allow: true });
  expect(decide("Write", { file_path: "src/b.ts" }, code)).toEqual({ allow: true });
  expect("deny" in decide("Bash", bash("git add -A && git commit -m fix"), code)).toBe(false);
  expect("deny" in decide("Bash", bash("git checkout -- src/a.ts"), code)).toBe(false); // restore a file
  denied(decide("Edit", { file_path: `${P}/src/a.ts` }, code), "code");
  denied(decide("Bash", bash(`echo x > ${P}/a.ts`), code), "code");
  denied(decide("Bash", bash(`git -C ${P} commit -m x`), code), "code");
  denied(decide("Bash", bash(`cd ${P} && git status && git merge side/8`), code), "code");
  denied(decide("Bash", bash("git switch main"), code), "code");
  denied(decide("Bash", bash("git checkout dev"), code), "code");
  denied(decide("Bash", bash("git push origin side/8"), code), "code");
  denied(decide("Bash", bash("docker compose up -d"), code), "code");
});

test("no lane: the governor is unchanged (a git commit is allowed, an edit in the folder too)", () => {
  const ctx: GovernorCtx = { folder: P, outOfFolderWrites: "allow", projectFence: FENCE };
  expect(decide("Bash", bash("git commit -am x"), ctx)).toEqual({ allow: true });
  expect(decide("Edit", { file_path: `${P}/a.ts` }, ctx)).toEqual({ allow: true });
  expect("escalate" in decide("Bash", bash("docker compose restart api && rm -rf x"), ctx)).toBe(true);
});

test("discarding output (/dev/null) is never a write the lane rules refuse", () => {
  for (const kind of ["read-only", "ops", "test"] as const) {
    expect("deny" in decide("Bash", bash("docker ps 2>/dev/null > /dev/null"), shared(kind)), kind).toBe(false);
  }
  expect("deny" in decide("Bash", bash("git status 2>/dev/null"), code)).toBe(false);
});

test("the lane reaches both governor entry points: canUseTool denies, and the PreToolUse hook routes the call to it", async () => {
  const { buildCanUseTool, buildGovernorHook } = await import("../src/engine/session-runner");
  const lane = { kind: "ops" as const, projectFolder: P, todoId: 7 };
  const handlers = { onMessage: () => {}, onEscalation: async () => "allow" as const };
  const canUse = buildCanUseTool(handlers, P, "neo", "allow", FENCE, lane);
  expect(await canUse("Bash", { command: "git commit -am x" })).toMatchObject({ behavior: "deny" });
  expect(await canUse("Bash", { command: "docker ps" })).toMatchObject({ behavior: "allow" });
  const hook = buildGovernorHook(P, "allow", undefined, FENCE, lane);
  const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: `${P}/a.ts` } } as never, undefined, { signal: new AbortController().signal });
  // The hook never decides itself: a non-allow verdict is "ask", which forces the call into canUseTool
  // (above), where the lane's deny is final — even when a project settings allow rule matches.
  expect(JSON.stringify(out)).toContain('"permissionDecision":"ask"');
  expect(JSON.stringify(out)).toContain("side lane (ops)");
});
