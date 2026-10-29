// ADR-0058: stop or background ONE running tool call — the seam, the marker sweep and the docker sweep.
import { test, expect } from "bun:test";
import { controlTool, readToolControlCfg, DEFAULT_TOOL_CONTROL_CFG } from "../src/engine/tool-control";
import { markedPids, treeOf, killPids, type ProcFs } from "../src/engine/proc-tree";
import { execTarget, execPidsFor, type DockerApi } from "../src/engine/docker-exec";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import type { ToolCalls } from "../src/types";

/** A fake /proc: pid -> { ppid, env, argv, cwd }. */
function fakeProc(t: Record<number, { ppid: number; env?: string[]; argv?: string[]; cwd?: string }>): ProcFs {
  return {
    list: () => Object.keys(t).map(Number),
    environ: (p) => t[p]?.env?.join("\0"),
    cmdline: (p) => t[p]?.argv,
    ppid: (p) => t[p]?.ppid,
    cwd: (p) => t[p]?.cwd,
  };
}
const M = (id: string) => [`PATH=/bin`, `NEO_TOOL_USE_ID=${id}`];

test("markedPids finds exactly the call's processes by its marker; treeOf walks children", () => {
  const fs = fakeProc({ 10: { ppid: 1, env: M("toolu_A") }, 11: { ppid: 10, env: M("toolu_A") }, 12: { ppid: 1, env: M("toolu_AB") }, 13: { ppid: 1, env: ["NEO_TOOL_USE_ID=x"] }, 14: { ppid: 11 } });
  expect(markedPids(fs, "toolu_A").sort()).toEqual([10, 11]); // toolu_AB is another call
  expect(treeOf(fs, 10).sort()).toEqual([10, 11, 14]);
});

test("killPids: SIGTERM, then SIGKILL for what survives the grace", async () => {
  const sent: string[] = [];
  const alive = new Set([101, 102]);
  const out = await killPids([1, 101, 102], {
    signal: (p, s) => (sent.push(`${s} ${p}`), s === "SIGTERM" && p === 101 ? alive.delete(101) : s === "SIGKILL" ? alive.delete(p) : true),
    alive: (p) => alive.has(p),
    graceMs: 5,
    sleep: async () => {},
  });
  expect(sent).toEqual(["SIGTERM 101", "SIGTERM 102", "SIGKILL 102"]); // pid 1 (init) is never signalled
  expect(out).toEqual({ killed: [101, 102], survived: [] });
});

test("execTarget parses docker exec and docker compose exec", () => {
  expect(execTarget(["docker", "exec", "-it", "-e", "A=1", "eticket-db", "psql", "-c", "select 1"])).toEqual({ kind: "container", name: "eticket-db", cmd: ["psql", "-c", "select 1"] });
  expect(execTarget(["docker", "compose", "-f", "dev.yml", "exec", "-T", "api", "go", "test", "./..."])).toEqual({ kind: "service", name: "api", cmd: ["go", "test", "./..."], project: undefined });
  expect(execTarget(["docker", "ps"])).toBeUndefined();
});

function fakeDocker(execs: Array<{ id: string; running: boolean; pid: number; cmd: string[] }>, containers: Record<string, string[]> = { "eticket-db": execs.map((e) => e.id) }): DockerApi {
  return {
    async get(path) {
      const c = /^\/containers\/([^/]+)\/json$/.exec(path);
      if (c) return containers[decodeURIComponent(c[1]!)] ? { Id: c[1], ExecIDs: containers[decodeURIComponent(c[1]!)] } : undefined;
      const e = /^\/exec\/([^/]+)\/json$/.exec(path);
      const x = execs.find((y) => y.id === e?.[1]);
      return x ? { Running: x.running, Pid: x.pid, ProcessConfig: { entrypoint: x.cmd[0], arguments: x.cmd.slice(1) } } : undefined;
    },
  };
}

test("execPidsFor: the running exec whose command matches; ambiguous → none, said so", async () => {
  const one = fakeDocker([{ id: "e1", running: true, pid: 900, cmd: ["psql", "-c", "select 1"] }, { id: "e2", running: true, pid: 901, cmd: ["bash"] }, { id: "e3", running: false, pid: 0, cmd: ["psql", "-c", "select 1"] }]);
  expect(await execPidsFor({ argv: ["docker", "exec", "eticket-db", "psql", "-c", "select 1"] }, one)).toEqual({ pids: [900] });
  const two = fakeDocker([{ id: "e1", running: true, pid: 900, cmd: ["sleep", "9"] }, { id: "e2", running: true, pid: 901, cmd: ["sleep", "9"] }]);
  const r = await execPidsFor({ argv: ["docker", "exec", "eticket-db", "sleep", "9"] }, two);
  expect(r.pids).toEqual([]);
  expect(r.note).toContain("2 identical");
});

function rig(tools: ToolCalls) {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const s = registry.add({ id: "s1", source: "neo", folder: "/home/eticket-v3", task: "t", chatId: 1, createdAt: 0 }, 0);
  const steers: string[] = [];
  registry.attachControl(s.id, { followUp: (t: string, timing: string) => void steers.push(`${timing}: ${t}`), interrupt: async () => {}, tools } as never);
  const lines: string[] = [];
  return { registry, ledger, s, steers, lines, reply: (text: string) => void lines.push(text) };
}
const claudeTools = (over: Partial<ToolCalls> = {}): ToolCalls => ({
  provider: "claude",
  running: () => [{ toolUseId: "toolu_A", tool: "Bash", summary: "git push origin dev", since: 5 }],
  background: async () => ({ ok: true, taskId: "bx1" }),
  stop: async () => ({ ok: true, taskId: "bx1" }),
  logOf: () => "/tmp/claude-0/x/tasks/bx1.output",
  ...over,
});

test("stop: SDK stop, then the marker sweep and the docker sweep; the worker is steered; one event and one feed line", async () => {
  const r = rig(claudeTools());
  const fs = fakeProc({ 20: { ppid: 1, env: M("toolu_A"), argv: ["bash", "-c", "x"] }, 21: { ppid: 20, env: M("toolu_A"), argv: ["docker", "exec", "eticket-db", "psql"] }, 900: { ppid: 1, argv: ["psql"] } });
  const killed: number[] = [];
  const out = await controlTool(
    { registry: r.registry, ledger: r.ledger, reply: r.reply, cfg: DEFAULT_TOOL_CONTROL_CFG, proc: fs, docker: fakeDocker([{ id: "e1", running: true, pid: 900, cmd: ["psql"] }]), signal: (p, s) => (s === "SIGTERM" && killed.push(p), true), alive: () => false, sleep: async () => {} },
    { sessionId: r.s.id, action: "stop", by: { kind: "operator", surface: "web" } },
  );
  expect(out).toMatchObject({ ok: true, toolUseId: "toolu_A", command: "git push origin dev" });
  expect(killed.sort()).toEqual([20, 21, 900]);
  expect(r.steers[0]).toContain("steer: The operator stopped your command `git push origin dev`");
  expect(r.steers[0]).toContain("Do not run it again unless told to");
  const ev = r.ledger.listEvents({ kind: "tool_control" })[0]!;
  expect(ev.data).toMatchObject({ action: "stop", outcome: "stopped", by: "operator:web", toolUseId: "toolu_A", summary: "git push origin dev", dockerKilled: [900] });
  expect(r.lines[0]).toContain("⏹");
});

test("background: the SDK backgrounds it and the reply names the log; nothing running → not_running", async () => {
  const r = rig(claudeTools());
  const deps = { registry: r.registry, ledger: r.ledger, reply: r.reply, cfg: DEFAULT_TOOL_CONTROL_CFG, proc: fakeProc({}), sleep: async () => {} };
  const out = await controlTool(deps, { sessionId: r.s.id, action: "background", by: { kind: "company" } });
  expect(out).toMatchObject({ ok: true, log: "/tmp/claude-0/x/tasks/bx1.output" });
  expect(out.text).toContain("/tmp/claude-0/x/tasks/bx1.output");
  const idle = rig(claudeTools({ running: () => [] }));
  expect(await controlTool({ ...deps, registry: idle.registry, ledger: idle.ledger }, { sessionId: idle.s.id, action: "stop", by: { kind: "company" } })).toMatchObject({ ok: false, outcome: "not_running" });
});

test("Codex: stop ends the turn (said plainly); background is refused", async () => {
  const r = rig({ provider: "codex", running: () => [{ toolUseId: "codex-turn", tool: "turn", summary: "the current Codex turn", since: 1 }], background: async () => ({ ok: false, reason: "Codex workers cannot move a command to the background" }), stop: async () => ({ ok: true }) });
  const deps = { registry: r.registry, ledger: r.ledger, reply: r.reply, cfg: DEFAULT_TOOL_CONTROL_CFG, proc: fakeProc({}), sleep: async () => {} };
  expect((await controlTool(deps, { sessionId: r.s.id, action: "stop", by: { kind: "company" } })).text).toContain("whole turn");
  expect(await controlTool(deps, { sessionId: r.s.id, action: "background", by: { kind: "company" } })).toMatchObject({ ok: false, outcome: "refused" });
});

test("config: defaults, and a bad value keeps its default", () => {
  expect(DEFAULT_TOOL_CONTROL_CFG).toEqual({ killGraceMs: 5000, noticeAfterMs: 120000, dockerSocket: "/var/run/docker.sock" });
  expect(readToolControlCfg({ killGraceMs: -1, noticeAfterMs: 60000, dockerSocket: "relative" })).toEqual({ ...DEFAULT_TOOL_CONTROL_CFG, noticeAfterMs: 60000 });
});

test("controlByProject: the project's main session; several running calls → a numbered list, then pick one", async () => {
  const { controlByProject } = await import("../src/engine/tool-control");
  const r = rig(claudeTools({
    running: () => [
      { toolUseId: "toolu_A", tool: "Bash", summary: "git push origin dev", since: 5 },
      { toolUseId: "toolu_B", tool: "Task", summary: "review the diff", since: 9 },
    ],
  }));
  const deps = { registry: r.registry, ledger: r.ledger, cfg: DEFAULT_TOOL_CONTROL_CFG, proc: fakeProc({}), sleep: async () => {}, now: () => 65_000 };
  const list = await controlByProject(deps, { project: "eticket-v3", action: "stop", by: { kind: "operator", surface: "command" } });
  expect(list.ok).toBe(false);
  expect(list.text).toContain("1. Bash 1m: git push origin dev");
  expect(list.text).toContain("2. Task 1m: review the diff");
  expect(list.text).toContain("/stop eticket-v3 2");
  const picked = await controlByProject(deps, { project: "eticket-v3", pick: 2, action: "background", by: { kind: "operator", surface: "command" } });
  expect(picked).toMatchObject({ ok: true, toolUseId: "toolu_B" });
  expect((await controlByProject(deps, { project: "nope", action: "stop", by: { kind: "company" } })).text).toContain("No open session");
});
