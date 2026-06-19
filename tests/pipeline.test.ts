import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleOrder } from "../src/engine/pipeline";
import { openLedger } from "../src/engine/ledger";
import type { NeoConfig } from "../src/config";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";
import type { Order } from "../src/types";

function cfg(): NeoConfig {
  return {
    telegramToken: "",
    telegramAllowFrom: [],
    geminiApiKey: "",
    providers: { ownWork: "subscription", customerWork: "gemini" },
    subscriptionInteractiveReservePct: 0.2,
    workRoot: "/home",
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "neo-pipe-"));

test("handleOrder replies with a usage hint for a bad command", async () => {
  const replies: string[] = [];
  await handleOrder("nonsense", 1, {
    cfg: cfg(),
    ledger: openLedger(":memory:"),
    reply: (_c, t) => void replies.push(t),
    askApproval: async () => "deny",
  });
  expect(replies.some((r) => r.includes("/open"))).toBe(true);
});

test("handleOrder runs a valid order, forwards worker text, and records the outcome", async () => {
  const dir = scratch();
  const led = openLedger(":memory:");
  const replies: string[] = [];
  const fakeRun = async (_o: Order, h: RunHandlers): Promise<RunResult> => {
    h.onMessage("doing work");
    return { ok: true, sessionId: "s1", summary: "completed", costUsd: 0.02 };
  };
  await handleOrder(`/open ${dir} do the thing`, 9, {
    cfg: cfg(),
    ledger: led,
    reply: (_c, t) => void replies.push(t),
    askApproval: async () => "allow",
    run: fakeRun,
  });
  expect(replies).toContain("doing work");
  expect(replies.some((r) => r.includes("completed"))).toBe(true);
  const recent = led.listRecent();
  expect(recent.length).toBe(1);
  expect(led.getOutcome(recent[0].id)?.status).toBe("done");
});

test("handleOrder wires worker escalations through askApproval", async () => {
  const dir = scratch();
  let asked = "";
  const replies: string[] = [];
  const fakeRun = async (_o: Order, h: RunHandlers): Promise<RunResult> => {
    const d = await h.onEscalation("risky shell command: rm -rf build");
    h.onMessage(`approval was ${d}`);
    return { ok: true, sessionId: "s", summary: "ok", costUsd: 0 };
  };
  await handleOrder(`/open ${dir} go`, 3, {
    cfg: cfg(),
    ledger: openLedger(":memory:"),
    reply: (_c, t) => void replies.push(t),
    askApproval: async (_c, reason) => ((asked = reason), "allow"),
    run: fakeRun,
  });
  expect(asked).toContain("rm");
  expect(replies).toContain("approval was allow");
});
