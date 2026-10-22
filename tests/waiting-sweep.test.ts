// ADR-0045: the waiting sweep — closes decisions only on checked evidence, gates the worker on new
// commits, and reminds the operator once per changed list.
import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createTrace } from "../src/engine/trace";
import type { GitRunner } from "../src/engine/git-read";
import { check, closeWithEvidence, keepJudged, waitingDecisions, DEFAULT_WAITING_SWEEP_CFG, readWaitingSweepCfg, type SweepDeps } from "../src/engine/waiting-sweep";

const ASKED = 1_000_000; // ms
const sec = (ms: number) => String(Math.floor(ms / 1000));

/** A fake repo at /home/p: commits by sha with their times, tracked files with their last change. */
function fakeGit(o: { latest?: number; commits?: Record<string, number>; files?: Record<string, number>; repo?: string | null } = {}): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((folder: string, args: string[]) => {
    calls.push([folder, ...args]);
    if (o.repo === null) return undefined;
    const [cmd] = args;
    if (cmd === "rev-parse" && args[1] === "--show-toplevel") return `${o.repo ?? "/home/p"}\n`;
    if (cmd === "log" && args.includes("--all")) return o.latest === undefined ? "" : `${sec(o.latest)}\n`;
    if (cmd === "cat-file") {
      const sha = args[2]!.replace("^{commit}", "");
      return o.commits?.[sha] !== undefined ? "" : undefined;
    }
    if (cmd === "show") {
      const sha = args[args.length - 1]!;
      return o.commits?.[sha] !== undefined ? `${sec(o.commits[sha]!)}\n` : undefined;
    }
    if (cmd === "ls-files") return o.files?.[args[args.length - 1]!] !== undefined ? `${args[args.length - 1]}\n` : undefined;
    if (cmd === "log" && args.includes("--")) {
      const t = o.files?.[args[args.length - 1]!];
      return t === undefined ? "" : `${sec(t)}\n`;
    }
    return undefined;
  }) as GitRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

function setup(git: GitRunner, now = ASKED + 10 * 3_600_000) {
  const led = openLedger(":memory:");
  const t = createTrace({ ledger: led, registry: createRegistry() });
  const root = t.inbound({ chatId: 7, text: "build the wallet", surface: "telegram" });
  let clock = now;
  const deps: SweepDeps = { ledger: led, refresh: (id) => t.refreshThread(id), git, now: () => clock, cfg: DEFAULT_WAITING_SWEEP_CFG, ref: (id) => t.ref(id) };
  return { led, t, root, deps, tick: (ms: number) => (clock += ms) };
}

function ask(s: ReturnType<typeof setup>, question = "Which bank?", folder = "/home/p") {
  const id = s.led.openDecision({ kind: "decision", question, cause: s.root, folder, project: "p" }, ASKED);
  s.t.refreshThread(s.root.threadId);
  return id;
}

test("config falls back to the defaults on bad values", () => {
  expect(readWaitingSweepCfg({ rejudgeAfterMs: -1, reminderMaxLines: "x" })).toEqual(DEFAULT_WAITING_SWEEP_CFG);
  expect(DEFAULT_WAITING_SWEEP_CFG).toEqual({ rejudgeAfterMs: 21_600_000, reminderMaxLines: 15 });
});

test("AC1: no WAITING thread → met, nothing to say", () => {
  const s = setup(fakeGit());
  expect(check(s.deps)).toMatchObject({ met: true, out: "" });
});

test("AC1/AC2: an unjudged decision needs judging; once kept, the reminder is printed once, then not again", () => {
  const s = setup(fakeGit({ latest: ASKED + 5_000 }));
  const id = ask(s);
  expect(waitingDecisions(s.deps).map((d) => d.id)).toEqual([id]);
  const first = check(s.deps);
  expect(first.met).toBe(false);
  expect(first.toJudge.map((d) => d.id)).toEqual([id]);

  expect(keepJudged(s.deps, id.slice(0, 8), "Pick the bank for wallet top-ups")).toEqual({ ok: true });
  const second = check(s.deps);
  expect(second.met).toBe(true);
  expect(second.out).toBe(`⏳ Waiting on you (1):\n• ${s.t.ref(s.root.threadId)} p — Pick the bank for wallet top-ups`);
  expect(check(s.deps)).toMatchObject({ met: true, out: "" }); // unchanged list → silent
});

test("AC2: a newer commit re-opens judging only after rejudgeAfterMs", () => {
  const git = fakeGit({ latest: ASKED + 5_000 });
  const s = setup(git);
  const id = ask(s);
  keepJudged(s.deps, id.slice(0, 8), "Pick the bank");
  check(s.deps);
  // a new commit lands, but the judgement is fresh → still met
  (git as unknown as { calls: unknown }).calls; // keep the fake alive
  const newer = fakeGit({ latest: ASKED + 9_000_000 });
  const deps2 = { ...s.deps, git: newer };
  expect(check(deps2).met).toBe(true);
  s.tick(DEFAULT_WAITING_SWEEP_CFG.rejudgeAfterMs);
  const due = check({ ...deps2, now: s.deps.now });
  expect(due.met).toBe(false);
  expect(due.toJudge.map((d) => d.id)).toEqual([id]);
});

test("AC3: close refuses without good evidence, and names the rule", () => {
  const s = setup(fakeGit({ latest: ASKED + 5_000, commits: { abc1234: ASKED - 5_000, def5678: ASKED + 5_000 }, files: { "docs/old.md": ASKED - 1 } }));
  const id = ask(s);
  const id8 = id.slice(0, 8);
  const r = (ev: { commit?: string; file?: string }, reason = "built in the wallet ADR") => closeWithEvidence(s.deps, id8, ev, reason);
  expect(closeWithEvidence(s.deps, "zzzzzzzz", { commit: "def5678" }, "built in the wallet ADR")).toEqual({ ok: false, why: "no open decision #zzzzzzzz in a waiting thread" });
  expect(r({ commit: "beefbee" })).toEqual({ ok: false, why: "commit beefbee is not in /home/p" });
  expect(r({ commit: "abc1234" })).toEqual({ ok: false, why: "commit abc1234 is older than the question" });
  expect(r({ commit: "--all" })).toEqual({ ok: false, why: "commit must be a hex sha" });
  expect(r({ file: "../../etc/passwd" })).toEqual({ ok: false, why: "file must be a path inside the repository" });
  expect(r({ file: "/etc/passwd" })).toEqual({ ok: false, why: "file must be a path inside the repository" });
  expect(r({ file: "docs/none.md" })).toEqual({ ok: false, why: "file docs/none.md is not tracked in /home/p" });
  expect(r({ file: "docs/old.md" })).toEqual({ ok: false, why: "file docs/old.md was last changed before the question" });
  expect(r({})).toEqual({ ok: false, why: "give exactly one of --commit or --file" });
  expect(r({ commit: "def5678" }, "short")).toEqual({ ok: false, why: "reason must be 10–300 characters" });
  expect(s.led.decisionById(id)?.status).toBe("open");
});

test("AC3: close refuses a plan card (it follows its plan)", () => {
  const s = setup(fakeGit({ latest: ASKED + 5_000, commits: { def5678: ASKED + 5_000 } }));
  const id = ask(s, "Plan waiting for your approval: docs/a.md");
  s.led.upsertPlan({ project: "p", folder: "/home/p", title: "t", sha256: "x", stepsTotal: 1, stepsDone: 0, threadId: s.root.threadId, createdAt: ASKED, updatedAt: ASKED, path: "docs/a.md", status: "sent", decisionId: id } as never);
  expect(closeWithEvidence(s.deps, id.slice(0, 8), { commit: "def5678" }, "built anyway, see ADR")).toEqual({ ok: false, why: "a plan card closes with its plan (/plans), not here" });
});

test("AC3: a good close supersedes with the evidence, cancels the parked todo, and the thread is done", () => {
  const s = setup(fakeGit({ latest: ASKED + 5_000, commits: { def5678: ASKED + 5_000 } }));
  const id = ask(s);
  const todo = s.led.addTodo({ project: "p", folder: "/home/p", brief: "continue", workClass: "interactive", createdBy: "operator", cause: s.root }, ASKED);
  s.led.updateTodo(todo.id, { status: "waiting", waitingOn: id });
  const out = closeWithEvidence(s.deps, id.slice(0, 8), { commit: "def5678" }, "the wallet bank was chosen in ADR-0151");
  expect(out).toEqual({ ok: true, thread: s.t.ref(s.root.threadId), todosCancelled: [todo.id] });
  expect(s.led.decisionById(id)).toMatchObject({ status: "superseded", answer: "done by later work: the wallet bank was chosen in ADR-0151 (commit def5678)" });
  expect(s.led.todoById(todo.id)?.status).toBe("cancelled");
  expect(s.led.threadById(s.root.threadId)?.state).toBe("done");
  expect(check(s.deps)).toMatchObject({ met: true, out: "" });
});

test("a file as evidence works when it changed after the question", () => {
  const s = setup(fakeGit({ latest: ASKED + 5_000, files: { "docs/VALIDATION.md": ASKED + 5_000 } }));
  const id = ask(s);
  expect(closeWithEvidence(s.deps, id.slice(0, 8), { file: "docs/VALIDATION.md" }, "skipped by the operator, see VALIDATION")).toMatchObject({ ok: true });
});

test("a decision outside any repository is never judged but still reminded", () => {
  const s = setup(fakeGit({ repo: null }));
  const id = ask(s, "Where do backups go?", "/nowhere");
  const out = check(s.deps);
  expect(out.met).toBe(true);
  expect(out.out).toContain("Where do backups go?");
  expect(closeWithEvidence(s.deps, id.slice(0, 8), { commit: "def5678" }, "decided somewhere else")).toEqual({ ok: false, why: "/nowhere is not in a git repository" });
});

test("the reminder caps its lines and counts extra questions per thread", () => {
  const s = setup(fakeGit({ repo: null }));
  s.deps.cfg = { ...DEFAULT_WAITING_SWEEP_CFG, reminderMaxLines: 1 };
  ask(s, "Q one?");
  ask(s, "Q two?");
  const other = s.t.inbound({ chatId: 7, text: "deploy gold", surface: "telegram" });
  s.led.openDecision({ kind: "decision", question: "Deploy now?", cause: other, folder: "/x", project: "gold" }, ASKED);
  s.t.refreshThread(other.threadId);
  const out = check(s.deps).out.split("\n");
  expect(out[0]).toBe("⏳ Waiting on you (2):");
  expect(out.length).toBe(3);
  expect(out[2]).toBe("…and 1 more");
});
