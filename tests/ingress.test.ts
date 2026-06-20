import { test, expect } from "bun:test";
import { runCompanyBrief } from "../src/engine/ingress";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { registerDefaultProject } from "../src/engine/default-project";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";

test("runCompanyBrief runs the brief on the company and returns its result", async () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  registerDefaultProject(registry, ledger, () => 1); // pins an idle company at /home/neo/agent
  const replies: string[] = [];
  let seenResume: string | undefined;
  const fakeRun = async (_o: Order, h: RunHandlers, d?: { resume?: string }): Promise<RunResult> => {
    seenResume = d?.resume;
    h.onMessage("looked it up");
    return { ok: true, sessionId: "co-1", summary: "order #7 ships tomorrow", costUsd: 0.01 };
  };

  const out = await runCompanyBrief("A customer asks: where is order #7? Answer them.", {
    cfg: {} as never, ledger, registry,
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    reply: (_c, t) => void replies.push(t),
    askApproval: async () => "deny",
    run: fakeRun as never, now: () => 2,
  });

  expect(out).toBe("order #7 ships tomorrow");
  expect(replies).toContain("looked it up");                 // streamed for observability
  expect(registry.getDefault()?.status).toBe("idle");        // company left idle
});
