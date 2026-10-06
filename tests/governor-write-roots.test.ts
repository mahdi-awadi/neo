// Write roots (ADR-0012): the path fence also allows scratch (/tmp) and the session's OWN Claude
// auto-memory dir, matched on real paths. Everything else outside the folder still escalates.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, expandWriteRoots, ownMemoryDir, OWN_MEMORY_TOKEN } from "../src/engine/governor";
import { profileDeps } from "../src/engine/worker-profile";
import { runOrder } from "../src/engine/session-runner";
import type { Order } from "../src/types";

const ENV = { HOME: "/root" };
const DEFAULT_ROOTS = ["/tmp", OWN_MEMORY_TOKEN];

function ctxFor(folder: string, env: Record<string, string | undefined> = ENV) {
  return { folder, writeRoots: expandWriteRoots(DEFAULT_ROOTS, folder, env) };
}
const allowed = (path: string, folder: string, tool = "Write") =>
  decide(tool, { file_path: path, content: "x" }, ctxFor(folder));
const escalates = (path: string, folder: string, tool = "Write") => {
  const v = decide(tool, { file_path: path, content: "x" }, ctxFor(folder));
  return "escalate" in v && v.fenced === true;
};

// --- the encoding Claude Code uses for its per-project dir ---

test("own memory dir is derived from the session folder and the home dir in the environment", () => {
  expect(ownMemoryDir("/home/neo", { HOME: "/root" })).toBe("/root/.claude/projects/-home-neo/memory");
  expect(ownMemoryDir("/home/prod-ops", { HOME: "/home/u" })).toBe("/home/u/.claude/projects/-home-prod-ops/memory");
  expect(ownMemoryDir("/home/a.b_c", { HOME: "/root" })).toBe("/root/.claude/projects/-home-a-b-c/memory");
  // CLAUDE_CONFIG_DIR wins over ~/.claude, as in Claude Code.
  expect(ownMemoryDir("/home/neo", { HOME: "/root", CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/projects/-home-neo/memory");
});

test("no home dir in the environment = no own memory root (fails closed)", () => {
  expect(expandWriteRoots([OWN_MEMORY_TOKEN], "/home/neo", {})).toEqual([]);
});

test("relative or empty root entries are ignored", () => {
  expect(expandWriteRoots(["tmp", "", "./x"], "/home/neo", ENV)).toEqual([]);
});

// --- the four writes the operator approved ---

test("scratch writes under /tmp are allowed (the prod-ops cases)", () => {
  expect(allowed("/tmp/ed/tests/clickhouse-config.test.sh", "/home/prod-ops")).toEqual({ allow: true });
  expect(allowed("/tmp/ed/docs/adr/0001-clickhouse-sizing-and-retention.md", "/home/prod-ops", "Edit")).toEqual({ allow: true });
});

test("a session writes its own memory dir (the /home/neo cases)", () => {
  expect(allowed("/root/.claude/projects/-home-neo/memory/plan-neo-research-improvements.md", "/home/neo")).toEqual({ allow: true });
  expect(allowed("/root/.claude/projects/-home-neo/memory/MEMORY.md", "/home/neo", "Edit")).toEqual({ allow: true });
});

test("NotebookEdit is covered by the same roots", () => {
  expect(decide("NotebookEdit", { notebook_path: "/tmp/n.ipynb" }, ctxFor("/home/neo"))).toEqual({ allow: true });
});

// --- what must still escalate ---

test("another project's memory dir escalates", () => {
  expect(escalates("/root/.claude/projects/-home-prod-ops/memory/MEMORY.md", "/home/neo")).toBe(true);
  expect(escalates("/root/.claude/projects/-home-neo/memory/x.md", "/home/prod-ops")).toBe(true);
});

test("the rest of ~/.claude escalates (only memory/ is a root)", () => {
  expect(escalates("/root/.claude/projects/-home-neo/session.jsonl", "/home/neo")).toBe(true);
  expect(escalates("/root/.claude/settings.json", "/home/neo")).toBe(true);
});

test("traversal out of a root escalates", () => {
  expect(escalates("/tmp/../etc/x", "/home/neo")).toBe(true);
  expect(escalates("/root/.claude/projects/-home-neo/memory/../../-home-x/memory/a.md", "/home/neo")).toBe(true);
  expect(escalates("/tmp", "/home/neo")).toBe(true); // the root itself is not a file to write
});

test("unrelated paths escalate", () => {
  expect(escalates("/etc/x", "/home/neo")).toBe(true);
  expect(escalates("/root/.ssh/x", "/home/neo")).toBe(true);
  expect(escalates("/tmpx/a", "/home/neo")).toBe(true); // sibling prefix of /tmp
});

// --- symlink escapes (real files on disk) ---

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "neo-roots-")));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

test("a symlink inside a root that points outside escalates (/tmp/x -> /etc)", () => {
  const scratch = join(sandbox, "scratch");
  const outside = join(sandbox, "outside");
  mkdirSync(scratch);
  mkdirSync(outside);
  symlinkSync(outside, join(scratch, "x"));
  const ctx = { folder: "/home/neo", writeRoots: expandWriteRoots([scratch], "/home/neo", ENV) };
  expect("escalate" in decide("Write", { file_path: join(scratch, "x", "passwd") }, ctx)).toBe(true);
  expect("escalate" in decide("Write", { file_path: join(scratch, "x", "new-dir", "f") }, ctx)).toBe(true);
  expect(decide("Write", { file_path: join(scratch, "real", "f") }, ctx)).toEqual({ allow: true });
});

test("a symlink to /etc inside the real /tmp escalates", () => {
  const link = join(sandbox, "etc-link");
  symlinkSync("/etc", link);
  expect(escalates(join(link, "x"), "/home/neo")).toBe(true);
});

test("the own memory dir allows a write when it is a real dir", () => {
  const home = join(sandbox, "home2");
  mkdirSync(join(home, ".claude", "projects", "-home-neo", "memory"), { recursive: true });
  const ctx = { folder: "/home/neo", writeRoots: expandWriteRoots([OWN_MEMORY_TOKEN], "/home/neo", { HOME: home }) };
  expect(decide("Write", { file_path: join(home, ".claude/projects/-home-neo/memory/MEMORY.md") }, ctx)).toEqual({ allow: true });
});

test("a root that is itself a symlink is ignored (a worker can't repoint its memory dir)", () => {
  const home = join(sandbox, "home");
  const projects = join(home, ".claude", "projects", "-home-neo");
  mkdirSync(projects, { recursive: true });
  const target = join(sandbox, "elsewhere");
  mkdirSync(target);
  symlinkSync(target, join(projects, "memory"));
  // Own-memory root only: the sandbox itself lives under /tmp, which is a root by default.
  const ctx = { folder: "/home/neo", writeRoots: expandWriteRoots([OWN_MEMORY_TOKEN], "/home/neo", { HOME: home }) };
  expect("escalate" in decide("Write", { file_path: join(projects, "memory", "MEMORY.md") }, ctx)).toBe(true);
});

test("no write roots = the old fence (default ctx)", () => {
  expect("escalate" in decide("Write", { file_path: "/tmp/x" }, { folder: "/home/neo" })).toBe(true);
});

// --- own work only ---

const workers = {
  company: {}, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: {}, handoff: {}, secretary: {},
};
const cfg = { workers, workerEnv: {}, governor: { writeRoots: DEFAULT_ROOTS } };

test("profileDeps gives the roots to own-work paths, never to ingress (customer-driven)", () => {
  for (const p of ["company", "project", "dispatch", "loop", "judge", "handoff", "secretary"] as const) {
    expect(profileDeps(cfg, p).writeRoots).toEqual(DEFAULT_ROOTS);
  }
  expect(profileDeps(cfg, "ingress").writeRoots).toBeUndefined();
});

function captureRun() {
  let seen: any;
  const q = (args: { options: any }) => {
    seen = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, session_id: "s" };
    })();
  };
  return { q, options: () => seen };
}

async function canUseFor(source: Order["source"], path: string) {
  const cap = captureRun();
  const order: Order = { id: "o", source, folder: "/home/neo", task: "t", chatId: 1, createdAt: 1 };
  const escalated: string[] = [];
  await runOrder(order, { onMessage: () => {}, onEscalation: async (r) => (escalated.push(r), "deny") }, {
    query: cap.q as never,
    writeRoots: DEFAULT_ROOTS,
  });
  const res = await cap.options().canUseTool("Write", { file_path: path, content: "x" });
  return { res, escalated };
}

test("an own-work session is wired with the roots (canUseTool allows /tmp)", async () => {
  const { res, escalated } = await canUseFor("neo", "/tmp/scratch.txt");
  expect(res.behavior).toBe("allow");
  expect(escalated).toEqual([]);
});

test("a customer-sourced order never gets the roots, even if RunDeps carries them", async () => {
  const { res, escalated } = await canUseFor("customer", "/tmp/scratch.txt");
  expect(res.behavior).toBe("deny");
  expect(escalated.length).toBe(1);
});
