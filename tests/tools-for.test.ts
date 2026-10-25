// `tools_for` and the dispatch tools hint (ADR-0044 Phase 2, spec A4, A9 #10).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { dispatchToProject, neoMcpServers, SUB_CHAT, briefWithProjectDocs, codebaseMemoryLine, type DispatchDeps } from "../src/engine/dispatch";
import { runCompanyBrief } from "../src/engine/ingress";
import { registerDefaultProject } from "../src/engine/default-project";
import { DEFAULT_TOOLS_CFG, openCatalogue, type ToolsCfg } from "../src/engine/tools-catalogue";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
const neoTools = (servers: Record<string, unknown>) =>
  (servers.neo as { instance: { _registeredTools: Record<string, { handler: Handler; inputSchema?: unknown }> } }).instance._registeredTools;

const BODY = "## How to call\nrun the thing with the CLI\n\n## When NOT to use\nnever\n";
function card(over: Record<string, unknown>): string {
  const base: Record<string, unknown> = {
    kind: "cli", status: "active", owner: "neo", when: "Use when a demo is needed.",
    scope: "all", env: [], cost: "free", limits: "none", dataLeavesHost: false, tags: ["demo"], examples: ["run a demo"],
  };
  const fm = Object.entries({ ...base, ...over }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  return `---\n${fm}\n---\n${BODY}`;
}
const CARDS = [
  { id: "shared-browser", when: "Use when a test needs a real browser: screenshots and E2E checks.", tags: ["browser", "screenshot", "e2e"], examples: ["take a screenshot of the login page"], cost: "free, 300 MB RAM", limits: "one tab at a time" },
  { id: "deploy-check", when: "Use to verify a deploy finished on Coolify.", tags: ["deploy", "coolify"], examples: ["check the prod deploy"] },
  { id: "eticket-data", kind: "mcp", when: "Use to query eticket booking data.", tags: ["eticket", "bookings"], examples: ["count bookings"], scope: ["eticket-v3"] },
];

function open(cfg: Partial<ToolsCfg> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "neo-tf-"));
  for (const c of CARDS) writeFileSync(join(dir, `${c.id}.md`), card(c));
  const ledger = openLedger(":memory:");
  const cat = openCatalogue({ dir, cfg: { ...DEFAULT_TOOLS_CFG, ...cfg }, ledger });
  return { cat, ledger };
}

function deps(tools?: ReturnType<typeof open>["cat"]): DispatchDeps {
  return {
    ledger: openLedger(":memory:"), registry: createRegistry(), meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"), reply: () => {}, askApproval: async () => "deny", ...(tools ? { tools } : {}),
  };
}

const ctx = { project: "waselni", folder: "/x/waselni" };

describe("tools_for reply", () => {
  test("blocks carry id, kind, allowed, why, how, cost and limits", async () => {
    const { cat } = open();
    const root = mkdtempSync(join(tmpdir(), "neo-tf-"));
    mkdirSync(join(root, "waselni"));
    const t = neoTools(neoMcpServers(deps(cat), 1, { dispatch: false, folder: join(root, "waselni"), projectName: "waselni" })).tools_for!;
    const out = (await t.handler({ task: "take a screenshot of the login page" }, {})).content[0]!.text!;
    expect(out).toContain("shared-browser · cli · allowed");
    expect(out).toContain("why: ");
    expect(out).toContain("how: run the thing with the CLI");
    expect(out).toContain("cost: free, 300 MB RAM");
    expect(out).toContain("limits: one tab at a time");
  });

  test("no match says so, in one line", async () => {
    const { cat } = open();
    const t = neoTools(neoMcpServers(deps(cat), 1, { dispatch: false, folder: "/x/waselni", projectName: "waselni" })).tools_for!;
    const out = (await t.handler({ task: "zzqqxx wwvvuu" }, {})).content[0]!.text!;
    expect(out).toMatch(/^no tool found/);
  });

  test("the reply is capped at replyMaxChars", async () => {
    const { cat } = open({ replyMaxChars: 120 });
    const t = neoTools(neoMcpServers(deps(cat), 1, { dispatch: false, folder: "/x/waselni", projectName: "waselni" })).tools_for!;
    const out = (await t.handler({ task: "browser screenshot deploy coolify demo" }, {})).content[0]!.text!;
    expect(out.length).toBeLessThanOrEqual(120);
  });

  test("the limit is bounded 1..10 in the input schema", () => {
    const { cat } = open();
    const t = neoTools(neoMcpServers(deps(cat), 1, { dispatch: false, folder: "/x/waselni" })).tools_for!;
    const shape = (JSON.parse(JSON.stringify(t.inputSchema)) as { def: { shape: Record<string, unknown> } }).def.shape;
    expect(Object.keys(shape).sort()).toEqual(["limit", "task"]);
  });

  test("only where deps.tools is wired", () => {
    expect(Object.keys(neoTools(neoMcpServers(deps(), 1, { dispatch: false, folder: "/x/waselni" })))).not.toContain("tools_for");
  });

  test("the customer (ingress) path never gets tools_for", async () => {
    const { cat } = open();
    const d = deps(cat);
    registerDefaultProject(d.registry, d.ledger, undefined, () => 1);
    let seen: { mcpServers?: Record<string, unknown> } | undefined;
    const fakeRun = async (_o: Order, _h: RunHandlers, x?: { mcpServers?: Record<string, unknown> }): Promise<RunResult> => {
      seen = x;
      return { ok: true, sessionId: "co-1", summary: "ok", costUsd: 0 };
    };
    await runCompanyBrief("take a screenshot of the login page", { ...d, cfg: { workers: {}, workerEnv: {} } as never, run: fakeRun as never, now: () => 2 });
    expect(seen?.mcpServers).toBeDefined();
    expect(Object.keys(neoTools(seen!.mcpServers!))).not.toContain("tools_for");
  });
});

describe("Catalogue.hint", () => {
  test("lines `- id (kind): when`, a closing line, within the caps", () => {
    const { cat } = open();
    const h = cat.hint("take a screenshot of the login page and check the deploy", ctx);
    expect(h).toContain("- shared-browser (cli): Use when a test needs a real browser");
    expect(h.trimEnd().endsWith("Ask tools_for for more.")).toBe(true);
    expect(h.trimEnd().length).toBeLessThanOrEqual(DEFAULT_TOOLS_CFG.hintMaxChars);
    expect(h.split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(DEFAULT_TOOLS_CFG.hintMaxCards);
  });
  test("a tiny hintMaxChars still never overflows", () => {
    const { cat } = open({ hintMaxChars: 80 });
    expect(cat.hint("take a screenshot of the login page", ctx).trimEnd().length).toBeLessThanOrEqual(80);
  });
  test("nothing scores → empty string, no header", () => {
    expect(open().cat.hint("zzqqxx wwvvuu", ctx)).toBe("");
  });
  test("a card out of scope for the project is not hinted", () => {
    const { cat } = open();
    expect(cat.hint("count eticket bookings", ctx)).not.toContain("eticket-data");
  });
  test("hintMaxCards limits the lines", () => {
    const { cat } = open({ hintMaxCards: 1 });
    expect(cat.hint("browser screenshot deploy coolify", ctx).split("\n").filter((l) => l.startsWith("- ")).length).toBe(1);
  });
});

describe("the hint in dispatchToProject", () => {
  const BRIEF = "take a screenshot of the login page";
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), "neo-tf-disp-"));
    mkdirSync(join(root, "waselni"));
    const tasks: string[] = [];
    const start = (o: Order) => {
      tasks.push(o.task);
      return { followUp: () => {}, queued: () => 0, interrupt: async () => {}, done: new Promise<RunResult>(() => {}) };
    };
    return { root, tasks, start };
  };

  test("a fresh dispatch with a matching brief starts with the hint, and the recorded order equals what the worker got", async () => {
    const { cat } = open();
    const { root, tasks, start } = fresh();
    const d = deps(cat);
    await dispatchToProject("waselni", BRIEF, d, 99, { start: start as never, now: () => 1, root });
    expect(tasks[0]).toContain("- shared-browser (cli):");
    expect(tasks[0]!.indexOf("Ask tools_for for more.")).toBeLessThan(tasks[0]!.indexOf(BRIEF));
    expect(d.ledger.listRecent(5).find((o) => o.task.includes(BRIEF))!.task).toBe(tasks[0]!);
  });

  test("the hint is injected after the notes block, so the task starts with it", async () => {
    const { cat } = open();
    const { root, tasks, start } = fresh();
    const d = { ...deps(cat), notes: { block: () => "[PROJECT NOTES]\n\n" } as never };
    await dispatchToProject("waselni", BRIEF, d, 99, { start: start as never, now: () => 1, root });
    expect(tasks[0]!.startsWith("Tools that may help:")).toBe(true);
    expect(tasks[0]!.indexOf("Ask tools_for for more.")).toBeLessThan(tasks[0]!.indexOf("[PROJECT NOTES]"));
  });

  test("a kept resume gets no hint", async () => {
    const { cat } = open();
    const { root, tasks, start } = fresh();
    const d = deps(cat);
    const prior: Order = { id: "prior", source: "neo", folder: join(root, "waselni"), task: "prior", chatId: SUB_CHAT, createdAt: 0 };
    const existing = d.registry.add(prior, 0);
    d.registry.setSdkSessionId(existing.id, "sdk-existing");
    d.registry.setStatus(existing.id, "idle");
    await dispatchToProject("waselni", BRIEF, d, 99, { start: start as never, now: () => 1, root });
    expect(tasks.at(-1)).not.toContain("Ask tools_for");
  });

  test("no deps.tools (ingress strips it) → no hint", async () => {
    const { root, tasks, start } = fresh();
    await dispatchToProject("waselni", BRIEF, deps(), 99, { start: start as never, now: () => 1, root });
    expect(tasks[0]).not.toContain("Ask tools_for");
  });

  test("a path not in hintPaths → no hint", async () => {
    const { cat } = open({ hintPaths: ["project"] });
    const { root, tasks, start } = fresh();
    await dispatchToProject("waselni", BRIEF, deps(cat), 99, { start: start as never, now: () => 1, root });
    expect(tasks[0]).not.toContain("Ask tools_for");
  });

  test("no match → the task has no hint and no empty header", async () => {
    const { cat } = open();
    const { root, tasks, start } = fresh();
    await dispatchToProject("waselni", "zzqqxx wwvvuu", deps(cat), 99, { start: start as never, now: () => 1, root });
    expect(tasks[0]).not.toContain("Ask tools_for");
    expect(tasks[0]).not.toMatch(/^\s*Tools/);
  });
});

