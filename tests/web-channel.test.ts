import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebChannel, type WebEvent } from "../src/engine/web-channel";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import type { NeoConfig } from "../src/config";
import type { RunHandlers, RunResult, SessionRun } from "../src/engine/session-runner";
import type { Order } from "../src/types";

function cfg(): NeoConfig {
  return {
    telegramToken: "",
    telegramAllowFrom: [],
    geminiApiKey: "",
    providers: { ownWork: "subscription", customerWork: "gemini" },
    subscriptionInteractiveReservePct: 0.2,
    workRoot: "/home",
    budgetWindowUsd: 100,
    budgetWindowMs: 3_600_000,
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "neo-web-"));

function fakeStart(onStart?: (h: RunHandlers) => void) {
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((r) => (resolveDone = r));
  const start = (_o: Order, h: RunHandlers): SessionRun => {
    onStart?.(h);
    return { followUp: () => {}, interrupt: async () => {}, done };
  };
  return { start, finish: (r: RunResult) => resolveDone(r) };
}

function engine(start: ReturnType<typeof fakeStart>["start"]) {
  return {
    cfg: cfg(),
    ledger: openLedger(":memory:"),
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    start,
  };
}

test("send drives the pipeline and emits worker messages as events", async () => {
  const dir = scratch();
  const f = fakeStart((h) => h.onMessage("hi from worker"));
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send(`/open ${dir} do it`);

  const texts = events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
  expect(texts).toContain("hi from worker");
});

test("escalations emit an event resolvable via resolveApproval", async () => {
  const dir = scratch();
  let captured!: RunHandlers;
  const f = fakeStart((h) => void (captured = h));
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send(`/open ${dir} go`);
  const decisionP = captured.onEscalation("risky shell command: rm -rf build");

  const esc = events.find((e) => e.type === "escalation") as { id: string; reason: string } | undefined;
  expect(esc).toBeTruthy();
  expect(esc!.reason).toContain("rm");
  expect(ch.resolveApproval(esc!.id, "allow")).toBe(true);
  expect(await decisionP).toBe("allow");
});

test("subscribers opened after activity get the replayed events", async () => {
  const dir = scratch();
  const f = fakeStart((h) => h.onMessage("earlier output"));
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });

  await ch.send(`/open ${dir} x`); // emit before anyone subscribes
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  const texts = events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
  expect(texts).toContain("earlier output");
});

test("send routes a slash-command through handleCommand and emits the reply", async () => {
  const f = fakeStart();
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send("/help");

  const texts = events.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
  // "/list" appears in the help text but NOT in handleMessage's "not an order" error.
  expect(texts.some((t) => t.includes("/list"))).toBe(true);
});

test("/list over the web emits a projects event with items; selectProject switches active", async () => {
  const dir = scratch();
  const f = fakeStart();
  const eng = engine(f.start);
  const ch = createWebChannel({ engine: eng, chatId: 42 });
  const events: WebEvent[] = [];
  ch.subscribe((e) => events.push(e));

  await ch.send(`/open ${dir} build`);
  await ch.send("/list");

  const proj = events.find((e) => e.type === "projects") as { type: "projects"; items: Array<{ id: string }> } | undefined;
  expect(proj).toBeTruthy();
  expect(proj!.items.length).toBe(1);

  ch.selectProject(proj!.items[0].id);
  expect(eng.registry.findByChat(42)?.id).toBe(proj!.items[0].id);
});

test("resolveApproval returns false for an unknown id", () => {
  const f = fakeStart();
  const ch = createWebChannel({ engine: engine(f.start), chatId: 42 });
  expect(ch.resolveApproval("nope", "deny")).toBe(false);
});
