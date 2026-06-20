import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProject, dispatchToProject, type DispatchDeps } from "../src/engine/dispatch";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";

test("resolveProject finds a folder by name under root or by absolute path", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  expect(resolveProject("eticket-v3", root)).toBe(join(root, "eticket-v3"));
  expect(resolveProject(join(root, "eticket-v3"), root)).toBe(join(root, "eticket-v3"));
  expect(resolveProject("nope", root)).toBeUndefined();
});

test("resolveProject resolves a desk name (research, dev, …), projects winning ties", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-root-"));
  const desks = mkdtempSync(join(tmpdir(), "neo-desks-"));
  mkdirSync(join(desks, "research"));
  expect(resolveProject("research", root, desks)).toBe(join(desks, "research")); // no project → desk
  mkdirSync(join(root, "research"));
  expect(resolveProject("research", root, desks)).toBe(join(root, "research")); // a real project wins
});

function makeDeps() {
  const replies: Array<{ text: string; project?: string }> = [];
  const d: DispatchDeps = {
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: (_c, text, project) => void replies.push({ text, project }),
    askApproval: async () => "deny",
  };
  return { d, replies };
}

test("dispatchToProject opens the target, streams tagged output, records it, returns the result", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d, replies } = makeDeps();
  const fakeRun = async (_o: Order, h: RunHandlers): Promise<RunResult> => {
    h.onMessage("docker: 3 containers up");
    return { ok: true, sessionId: "sub-1", summary: "3 containers up", costUsd: 0.02 };
  };

  const out = await dispatchToProject("eticket-v3", "report docker status", d, 99, {
    run: fakeRun as never,
    now: () => 1,
    root,
  });

  expect(out).toBe("3 containers up");
  const sub = d.registry.list().find((s) => s.order.folder === join(root, "eticket-v3"))!;
  expect(sub).toBeTruthy();
  expect(sub.order.chatId).toBe(-2); // reserved sub-chat — won't hijack the operator's routing
  expect(sub.status).toBe("idle"); // kept resumable after completion
  expect(replies.some((r) => r.text.includes("docker: 3 containers up") && r.project === sub.name)).toBe(true);
  expect(d.ledger.getOutcome(d.ledger.listRecent()[0].id)?.status).toBe("done");
});

test("dispatching twice to the same project reuses its session (no eticket-v3-2 duplicate)", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-disp-"));
  mkdirSync(join(root, "eticket-v3"));
  const { d } = makeDeps();
  let n = 0;
  const fakeRun = async (): Promise<RunResult> => ({ ok: true, sessionId: `s${++n}`, summary: "ok", costUsd: 0 });

  await dispatchToProject("eticket-v3", "task 1", d, 99, { run: fakeRun as never, now: () => 1, root });
  await dispatchToProject("eticket-v3", "task 2", d, 99, { run: fakeRun as never, now: () => 2, root });

  const subs = d.registry.list().filter((s) => s.order.folder === join(root, "eticket-v3"));
  expect(subs.length).toBe(1); // one entry, reused
  expect(subs[0].name).toBe("eticket-v3"); // not "eticket-v3-2"
});

test("dispatchToProject reports a clear error for an unknown project (and never runs)", async () => {
  const { d } = makeDeps();
  const out = await dispatchToProject("ghost", "do x", d, 99, {
    run: (async () => {
      throw new Error("should not run");
    }) as never,
    root: "/nonexistent",
  });
  expect(out.toLowerCase()).toContain("no project");
});
