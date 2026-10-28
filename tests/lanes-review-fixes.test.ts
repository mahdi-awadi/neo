// ADR-0057 review fixes: the governor gaps (quoted redirects, wrapper commands, missed lifecycle
// commands, symlinks, ref changes) and the lane isolation of sessions, decisions and the queue.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { decide, type GovernorCtx } from "../src/engine/governor";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createLaneWorktree } from "../src/engine/lane-worktree";
import { raiseOperatorDecision, SIDE_CHAT, SUB_CHAT } from "../src/engine/dispatch";

const P = "/home/p";
const FENCE = { root: "/home" };
const lane = (kind: "ops" | "read-only" | "code", folder = P, projectFolder = P): GovernorCtx => ({ folder, outOfFolderWrites: "allow", projectFence: FENCE, lane: { kind, projectFolder, todoId: 5 } });
const denied = (cmd: string, ctx: GovernorCtx) => "deny" in decide("Bash", { command: cmd }, ctx);

test("a quoted redirect target is still a write: the lane rule and the project fence both see it", () => {
  expect(denied(`echo x > "${P}/a.txt"`, lane("ops"))).toBe(true);
  expect(denied(`echo x >> '${P}/a.txt'`, lane("ops"))).toBe(true);
  expect(denied(`echo "a > b" > /tmp/ok.txt`, lane("ops"))).toBe(false); // a > inside quotes is text
  const fenced = decide("Bash", { command: `echo x > "/home/other/a.txt"` }, { folder: P, outOfFolderWrites: "allow", projectFence: FENCE });
  expect("escalate" in fenced && fenced.fenced).toBe(true);
});

test("wrapper commands do not hide the real command", () => {
  for (const c of ["timeout 30 docker compose restart api", "nohup docker compose up -d", "command git stash", "xargs git add < list", "sudo -E docker restart x", "nice -n 5 git commit -m x", "exec git reset --hard", "time git checkout main", "stdbuf -oL docker compose stop"]) {
    expect(denied(c, lane("ops")), c).toBe(true);
  }
  expect(denied("timeout 30 docker compose logs api", lane("ops"))).toBe(false);
});

test("lifecycle commands the first version missed", () => {
  for (const c of ["docker compose --project-directory /p restart", "docker compose --ansi never up -d", "docker compose run api sh", "docker system prune -f", "docker volume rm data", "service nginx restart", "docker container prune"]) {
    expect(denied(c, lane("ops")), c).toBe(true);
  }
  expect(denied("docker compose exec api sh -c 'ls'", lane("ops"))).toBe(false);
});

test("a symlink into the project is judged where it leads", () => {
  const real = mkdtempSync(join(tmpdir(), "neo-lane-real-"));
  const link = join(tmpdir(), `neo-lane-link-${process.pid}-${Date.now()}`);
  symlinkSync(real, link);
  expect("deny" in decide("Write", { file_path: join(link, "f.txt") }, lane("read-only", real, real))).toBe(true);
  expect(denied(`echo x > ${link}/f.txt`, lane("ops", real, real))).toBe(true);
});

test("a code lane may not move refs the main checkout shares", () => {
  const wt = join(tmpdir(), "neo-lanes", "p-side-5");
  for (const c of ["git update-ref refs/heads/dev HEAD", "git branch -D dev", "git branch -m dev other", "git branch --force dev HEAD~1"]) {
    expect(denied(c, lane("code", wt)), c).toBe(true);
  }
  expect(denied("git branch", lane("code", wt))).toBe(false);
  expect(denied("git update-ref refs/heads/x HEAD", lane("ops"))).toBe(true); // a git write for every kind
});

test("a side lane's question marks ITS session blocked, not the folder's main session", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const main = registry.add({ id: "m", source: "neo", folder: P, task: "build", chatId: SUB_CHAT, createdAt: 0 }, 0);
  const side = registry.add({ id: "s", source: "neo", folder: P, task: "check", chatId: SIDE_CHAT, createdAt: 0 }, 0, { lane: { kind: "ops", projectFolder: P, todoId: 5 } });
  await raiseOperatorDecision({ ledger, registry }, { project: "p", folder: P, orderId: "s", chatId: 1, question: "Which user?", sessionId: side.id });
  expect(registry.get(side.id)?.blockedOn?.kind).toBe("decision");
  expect(registry.get(main.id)?.blockedOn).toBeUndefined();
});

test("a side lane's conversation is never the folder's resume point (its own chat id)", () => {
  const ledger = openLedger(":memory:");
  ledger.recordOrder({ id: "main", source: "neo", folder: P, task: "build", chatId: SUB_CHAT, createdAt: 1 });
  ledger.recordSession("main", "sdk-main");
  ledger.recordOrder({ id: "side", source: "neo", folder: P, task: "check", chatId: SIDE_CHAT, createdAt: 2 });
  ledger.recordSession("side", "sdk-side");
  expect(ledger.lastSessionFor(P, SUB_CHAT)).toBe("sdk-main");
  expect(SIDE_CHAT).not.toBe(SUB_CHAT);
});

test("done-closing stays within a lane: a side end never closes a main retry, and back", () => {
  const ledger = openLedger(":memory:");
  const cause = { msgId: 1, threadId: 1 };
  const main = ledger.addTodo({ project: "p", folder: P, brief: "build", workClass: "interactive", createdBy: "company", cause }, 1);
  ledger.updateTodo(main.id, { status: "retry", endedAt: 2, retryAt: 99 });
  const side = ledger.addTodo({ project: "p", folder: P, brief: "check", workClass: "interactive", createdBy: "company", cause, lane: "side", laneKind: "ops" }, 3);
  expect(ledger.closeSupersededTodos(1, P, side.id, 4)).toEqual([]);
  expect(ledger.todoById(main.id)?.status).toBe("retry");
});

test("queue positions are per lane: a queued side todo never shifts the main queue's numbers", () => {
  const ledger = openLedger(":memory:");
  const a = ledger.addTodo({ project: "p", folder: P, brief: "A", workClass: "interactive", createdBy: "company" }, 1);
  const s = ledger.addTodo({ project: "p", folder: P, brief: "S", workClass: "interactive", createdBy: "company", lane: "side", laneKind: "ops" }, 2);
  const b = ledger.addTodo({ project: "p", folder: P, brief: "B", workClass: "interactive", createdBy: "company" }, 3);
  expect([a.position, b.position]).toEqual([1, 2]);
  ledger.moveTodo(s.id, 1);
  ledger.moveTodo(b.id, 1);
  expect(ledger.listTodos({ folder: P, statuses: ["queued"], lane: "main" }).map((t) => t.brief)).toEqual(["B", "A"]);
});

test("a kept (dirty) worktree is reused when its code lane is retried", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-lrf-")) + "/proj";
  mkdirSync(dir);
  const g = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "dev");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  const root = mkdtempSync(join(tmpdir(), "neo-lrf-wt-"));
  const first = createLaneWorktree(dir, "9", root);
  if ("error" in first) throw new Error(first.error);
  writeFileSync(join(first.path, "wip.txt"), "half\n");
  const again = createLaneWorktree(dir, "9", root);
  if ("error" in again) throw new Error(again.error);
  expect(again.path).toBe(first.path);
  expect(again.baseSha).toBe(first.baseSha);
});
