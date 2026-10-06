import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand, selectProject, killProject, telegramCommands } from "../src/engine/commands";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { openTrustStore } from "../src/engine/trust";
import { openInbox } from "../src/engine/inbox";
import type { Order, Provider } from "../src/types";

function order(over: Partial<Order> = {}): Order {
  return {
    id: over.id ?? crypto.randomUUID(),
    source: "neo",
    folder: over.folder ?? "/proj/app",
    task: over.task ?? "do the thing",
    chatId: over.chatId ?? 1,
    createdAt: 1,
  };
}
function deps(
  over: {
    registry?: ReturnType<typeof createRegistry>;
    ledger?: ReturnType<typeof openLedger>;
    usage?: any;
    inbox?: ReturnType<typeof openInbox>;
    cfg?: { providers: { ownWork: Provider; customerWork: Provider } };
    now?: () => number;
  } = {},
) {
  return {
    registry: over.registry ?? createRegistry(),
    ledger: over.ledger ?? openLedger(":memory:"),
    usage: over.usage as any,
    trust: openTrustStore(":memory:"),
    inbox: over.inbox,
    cfg: over.cfg,
    now: over.now ?? (() => 100000),
  };
}

function fakeUsage(over: { hourly?: number; daily?: number; weekly?: number; rateLimits?: any[] } = {}) {
  const w = (consumedTokens: number) => ({ consumedTokens, consumedInput: 0, consumedOutput: 0, capTokens: null, remaining: null });
  return {
    snapshot: () => ({
      perWindow: { hourly: w(over.hourly ?? 41_800_000), daily: w(over.daily ?? 1_100_000_000), weekly: w(over.weekly ?? 5_000_000_000) },
      contextOccupancy: 477_000,
      weeklyResetAt: Date.parse("2026-06-22T10:00:00.000Z"),
      rateLimits: over.rateLimits ?? [],
      turnCount: 100,
      computedAt: 0,
    }),
  };
}

test("/inbox lists queued customer messages newest-first with tappable entries", () => {
  const inbox = openInbox(":memory:");
  inbox.record({ from: "a@x.com", fromName: "Ann", subject: "Quote?", text: "How much?" }, 1000);
  const b = inbox.record({ from: "b@x.com", subject: "Refund", text: "please" }, 2000);
  const res = handleCommand("/inbox", 1, deps({ inbox }))!;
  expect(res.text).toContain("Ann");
  expect(res.text).toContain("Refund");
  expect(res.inbox?.map((i) => i.id)).toEqual([b.id, inbox.list()[1].id]); // newest first
});

test("/inbox reports an empty inbox", () => {
  const res = handleCommand("/inbox", 1, deps({ inbox: openInbox(":memory:") }))!;
  expect(res.text.toLowerCase()).toContain("empty");
  expect(res.inbox).toEqual([]);
});

test("/inbox degrades gracefully when no inbox is wired", () => {
  expect(handleCommand("/inbox", 1, deps())!.text.toLowerCase()).toContain("unavailable");
});

test("/help lists the available commands including /open", () => {
  const out = handleCommand("/help", 1, deps())!.text;
  expect(out).toContain("/open");
  expect(out).toContain("/list");
  expect(out).toContain("/kill");
  expect(out).toContain("/trust [<project-or-folder>] [on|off]");
});

test("/list shows open projects with name, folder, status, and task", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/proj/app", task: "add tests to math" }), 1000);
  const out = handleCommand("/list", 1, deps({ registry }))!.text;
  expect(out).toContain("app");
  expect(out).toContain("/proj/app");
  expect(out).toContain("add tests");
});

test("/list reports none when there are no open projects", () => {
  expect(handleCommand("/list", 1, deps())!.text.toLowerCase()).toContain("no open projects");
});

test("/status is an alias of /list", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/p/x" }), 1);
  const d = deps({ registry });
  expect(handleCommand("/status", 1, d)!.text).toBe(handleCommand("/list", 1, d)!.text);
});

test("there is NO budget/dollar readout anymore", () => {
  const registry = createRegistry();
  registry.add(order(), 1);
  const out = handleCommand("/list", 1, deps({ registry }))!.text;
  expect(out).not.toContain("$");
  expect(out.toLowerCase()).not.toContain("budget");
});

test("/kill interrupts a named session and drops it", () => {
  const registry = createRegistry();
  const o = order({ folder: "/p/app" });
  registry.add(o, 1);
  let interrupted = false;
  registry.attachControl(o.id, { followUp: () => {}, interrupt: async () => void (interrupted = true) });
  const out = handleCommand("/kill app", 1, deps({ registry }))!.text;
  expect(out).toContain("Killed");
  expect(interrupted).toBe(true);
  expect(registry.findByName("app")).toBeUndefined();
});

test("/kill an unknown name returns a friendly error; no name returns usage", () => {
  expect(handleCommand("/kill ghost", 1, deps())!.text).toContain("not found");
  expect(handleCommand("/kill", 1, deps())!.text.toLowerCase()).toContain("usage");
});

test("/use addresses a project for ONE message and /list marks it", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  registry.add(order({ folder: "/p/beta", chatId: 1 }), 2);
  const d = deps({ registry });
  const msg = handleCommand("/use alpha", 1, d)!.text.toLowerCase();
  expect(msg).toContain("alpha");
  expect(msg).toContain("next message"); // one-shot phrasing
  expect(registry.getFocus(1)).toMatchObject({ mode: "once" });
  const list = handleCommand("/list", 1, d)!.text;
  const alphaLine = list.split("\n").find((l) => l.includes("alpha"))!;
  const betaLine = list.split("\n").find((l) => l.includes("beta"))!;
  expect(alphaLine).toContain("▶"); // one-shot focus marker
  expect(betaLine).not.toContain("▶");
});

test("/pin holds a project across messages; /unpin returns to the company", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  const d = deps({ registry });
  expect(handleCommand("/pin alpha", 1, d)!.text.toLowerCase()).toContain("pinned");
  expect(registry.getFocus(1)).toMatchObject({ mode: "pinned" });
  const list = handleCommand("/list", 1, d)!.text;
  expect(list.split("\n").find((l) => l.includes("alpha"))!).toContain("📌");
  expect(handleCommand("/unpin", 1, d)!.text.toLowerCase()).toContain("company");
  expect(registry.getFocus(1)).toBeUndefined();
});

test("/company is an alias for /unpin", () => {
  const registry = createRegistry();
  const a = registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  registry.setFocus(1, a.id, "pinned");
  const d = deps({ registry });
  handleCommand("/company", 1, d);
  expect(registry.getFocus(1)).toBeUndefined();
});

test("/use and /pin on an unknown project are friendly errors", () => {
  expect(handleCommand("/use ghost", 1, deps())!.text).toContain("not found");
  expect(handleCommand("/pin ghost", 1, deps())!.text).toContain("not found");
});

test("/recent shows recent orders with their outcomes", () => {
  const ledger = openLedger(":memory:");
  ledger.recordOrder(order({ id: "a", folder: "/p/alpha", task: "add tests", createdAt: 1 }));
  ledger.recordOutcome("a", "done", "added 3 tests");
  ledger.recordOrder(order({ id: "b", folder: "/p/beta", task: "fix bug", createdAt: 2 }));
  const out = handleCommand("/recent", 1, deps({ ledger }))!.text;
  expect(out).toContain("alpha");
  expect(out).toContain("add tests");
  expect(out).toContain("done");
  expect(out).toContain("beta"); // newest, still pending
});

test("/recent with no orders reports none", () => {
  expect(handleCommand("/recent", 1, deps())!.text.toLowerCase()).toContain("no orders");
});

test("/events renders recent engine events newest-first; a kind arg filters", () => {
  const ledger = openLedger(":memory:");
  ledger.recordEvent("dispatch_start", { folder: "/p/gold", data: { project: "gold" }, at: 1 });
  ledger.recordEvent("api_retry", { folder: "/p/safari", data: { project: "safari", attempt: 1, delayMs: 30000 }, at: 2 });
  const all = handleCommand("/events", 1, deps({ ledger }))!.text;
  expect(all).toContain("api_retry");
  expect(all).toContain("dispatch_start");
  expect(all).toContain("safari"); // folder basename surfaced
  const filtered = handleCommand("/events api_retry", 1, deps({ ledger }))!.text;
  expect(filtered).toContain("api_retry");
  expect(filtered).not.toContain("dispatch_start");
});

test("/events with no events shows a friendly line", () => {
  expect(handleCommand("/events", 1, deps())!.text.toLowerCase()).toContain("no events");
});

test("/events is advertised in telegramCommands", () => {
  expect(telegramCommands().some((c) => c.command === "events")).toBe(true);
});

test("/sdk reports and switches the own-work SDK provider", () => {
  const cfg = { providers: { ownWork: "subscription" as Provider, customerWork: "gemini" as Provider } };
  const d = deps({ cfg });

  expect(handleCommand("/sdk", 1, d)!.text).toContain("Claude Agent SDK");
  const codex = handleCommand("/sdk codex", 1, d)!;
  expect(codex.text).toContain("OpenAI Codex SDK");
  expect(codex.sdk?.provider).toBe("codex");
  expect(cfg.providers.ownWork).toBe("codex");

  const claude = handleCommand("/sdk claude", 1, d)!;
  expect(claude.text).toContain("Claude Agent SDK");
  expect(claude.sdk?.provider).toBe("subscription");
  expect(cfg.providers.ownWork).toBe("subscription");
});

test("/sdk accepts Telegram's @bot suffix", () => {
  const cfg = { providers: { ownWork: "subscription" as Provider, customerWork: "gemini" as Provider } };

  const result = handleCommand("/sdk@neo_bot codex", 1, deps({ cfg }))!;

  expect(result.sdk?.provider).toBe("codex");
  expect(cfg.providers.ownWork).toBe("codex");
});

test("/sdk rejects unknown or customer-only providers without changing config", () => {
  const cfg = { providers: { ownWork: "subscription" as Provider, customerWork: "gemini" as Provider } };
  const out = handleCommand("/sdk gemini", 1, deps({ cfg }))!;
  expect(out.text).toContain("Unknown SDK");
  expect(out.text).toContain("claude or codex");
  expect(cfg.providers.ownWork).toBe("subscription");
});

test("/sdk is advertised in telegramCommands", () => {
  expect(telegramCommands().some((c) => c.command === "sdk")).toBe(true);
});

test("/usage renders hourly/daily/weekly token usage + weekly reset, no dollars", () => {
  const out = handleCommand("/usage", 1, deps({ usage: fakeUsage() }))!.text;
  expect(out).toContain("41.8M");
  expect(out).toContain("1.1B");
  expect(out).toContain("5.0B");
  expect(out.toLowerCase()).toContain("weekly");
  expect(out).toContain("resets");
  expect(out).not.toContain("$"); // measured tokens, not a dollar budget
});

test("/usage degrades gracefully when no meter is wired", () => {
  expect(handleCommand("/usage", 1, deps())!.text.toLowerCase()).toContain("unavailable");
});

test("/usage shows per-window limit status and % left when the SDK provides it", () => {
  const usage = fakeUsage({
    rateLimits: [
      { status: "allowed", rateLimitType: "five_hour", resetsAt: 1781923200 },
      { status: "allowed_warning", rateLimitType: "seven_day", resetsAt: 1782000000, utilization: 0.88 },
    ],
  });
  const out = handleCommand("/usage", 1, deps({ usage }))!.text;
  expect(out).toContain("5-hour");
  expect(out.toLowerCase()).toContain("within limit"); // five_hour, no utilization sent
  expect(out).toContain("7-day");
  expect(out).toContain("88% used"); // seven_day utilization 0.88
  expect(out).toContain("12% left");
});

test("/list returns selectable projects with the active one flagged", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  const b = registry.add(order({ folder: "/p/beta", chatId: 1 }), 2);
  registry.setFocus(1, b.id, "once");
  const res = handleCommand("/list", 1, deps({ registry }))!;
  expect(res.select?.map((s) => s.label)).toEqual(["alpha", "beta"]);
  const beta = res.select?.find((s) => s.label === "beta");
  expect(beta?.active).toBe(true);
  expect(beta?.id).toBe(b.id);
  expect(beta?.folder).toBe("/p/beta");
  expect(beta?.status).toBe("running");
});

test("killProject interrupts + removes the session and returns the refreshed list", () => {
  const registry = createRegistry();
  const a = registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  registry.add(order({ folder: "/p/beta", chatId: 1 }), 2);
  let interrupted = false;
  registry.attachControl(a.id, { followUp: () => {}, interrupt: async () => void (interrupted = true) });
  const res = killProject(a.id, 1, deps({ registry }));
  expect(interrupted).toBe(true);
  expect(registry.get(a.id)).toBeUndefined();
  expect(res.select?.map((s) => s.label)).toEqual(["beta"]);
});

test("selectProject sets the active project and returns the refreshed list", () => {
  const registry = createRegistry();
  const a = registry.add(order({ folder: "/p/alpha", chatId: 1 }), 1);
  registry.add(order({ folder: "/p/beta", chatId: 1 }), 2);
  const res = selectProject(a.id, 1, deps({ registry }));
  expect(registry.findByChat(1)?.id).toBe(a.id);
  expect(res.select?.find((s) => s.label === "alpha")?.active).toBe(true);
});

test("returns null for /open and unknown input so the pipeline handles them", () => {
  expect(handleCommand("/open /x do it", 1, deps())).toBeNull();
  expect(handleCommand("just chatting", 1, deps())).toBeNull();
});

test("killProject refuses to kill the default company project", () => {
  const registry = createRegistry();
  const o = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  registry.add(o, 0);
  registry.setDefault(o.id);
  const d = deps({ registry });

  const result = killProject("company", 1, d);

  expect(result.text).toContain("always-on");
  expect(registry.get("company")).toBeDefined(); // not removed
});

test("/trust on trusts the company when it is the fallback target, then /trust off untrusts", () => {
  const registry = createRegistry();
  const o = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  registry.add(o, 0);
  registry.setDefault(o.id); // free-text falls back to the company
  const trust = openTrustStore(":memory:");
  const d = { registry, ledger: openLedger(":memory:"), trust, now: () => 1 };

  expect(handleCommand("/trust on", 5, d)!.text).toContain("🔓");
  expect(trust.isTrusted("/home/neo/agent")).toBe(true);
  expect(handleCommand("/trust", 5, d)!.text).toContain("trusted");
  expect(handleCommand("/trust off", 5, d)!.text).toContain("🔒");
  expect(trust.isTrusted("/home/neo/agent")).toBe(false);
});

test("/trust on then /trust toggles and reports trust when a project is explicitly selected", () => {
  const registry = createRegistry();
  const company = order({ id: "company", folder: "/home/neo/agent", chatId: -1 });
  registry.add(company, 0);
  registry.setDefault(company.id);
  const proj = order({ id: "proj1", folder: "/home/neo/myproject", chatId: 5 });
  registry.add(proj, 0);
  registry.setFocus(5, proj.id, "once"); // chatId 5 has explicitly selected proj1
  const trust = openTrustStore(":memory:");
  const d = { registry, ledger: openLedger(":memory:"), trust, now: () => 1 };

  expect(handleCommand("/trust on", 5, d)!.text).toContain("🔓");
  expect(trust.isTrusted("/home/neo/myproject")).toBe(true);
  expect(handleCommand("/trust", 5, d)!.text).toContain("trusted");
  expect(handleCommand("/trust off", 5, d)!.text).toContain("🔒");
  expect(trust.isTrusted("/home/neo/myproject")).toBe(false);
});

test("/trust can pre-trust an unopened absolute folder", () => {
  const folder = mkdtempSync(join(tmpdir(), "neo-trust-"));
  try {
    const trust = openTrustStore(":memory:");
    const d = { registry: createRegistry(), ledger: openLedger(":memory:"), trust, now: () => 1 };

    expect(handleCommand(`/trust ${folder} on`, 5, d)!.text).toContain("🔓");
    expect(trust.isTrusted(folder)).toBe(true);
    expect(handleCommand(`/trust ${folder}`, 5, d)!.text).toContain("trusted");
    expect(handleCommand(`/trust ${folder} off`, 5, d)!.text).toContain("🔒");
    expect(trust.isTrusted(folder)).toBe(false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("/trust can pre-trust an unopened bare project name under /home", () => {
  const trust = openTrustStore(":memory:");
  const d = { registry: createRegistry(), ledger: openLedger(":memory:"), trust, now: () => 1 };

  expect(handleCommand("/trust neo on", 5, d)!.text).toContain("🔓");
  expect(trust.isTrusted("/home/neo")).toBe(true);
  expect(handleCommand("/trust neo", 5, d)!.text).toContain("/home/neo");
});

test("/trust with an explicit open session name uses that session folder", () => {
  const registry = createRegistry();
  registry.add(order({ folder: "/workspace/adminli", chatId: 5 }), 1);
  const trust = openTrustStore(":memory:");
  const d = { registry, ledger: openLedger(":memory:"), trust, now: () => 1 };

  expect(handleCommand("/trust adminli on", 5, d)!.text).toContain("/workspace/adminli");
  expect(trust.isTrusted("/workspace/adminli")).toBe(true);
});

test("/trust with an unknown explicit target returns a clear not-found message", () => {
  const out = handleCommand("/trust definitely-not-a-real-neo-project on", 5, deps())!.text;

  expect(out).toContain("Project or folder not found");
  expect(out).toContain("definitely-not-a-real-neo-project");
});

test("/status shows current activity, how long since it was seen, and queue depth for a WORKING session", () => {
  const registry = createRegistry();
  const o = order({ folder: "/p/gold", task: "build" });
  const s = registry.add(o, 0);
  registry.setStatus(s.id, "running");
  registry.noteActivity(s.id, "Bash: bun test", 100000 - 4 * 60_000);
  // A turn genuinely in flight — without this the session is idle between turns, and saying it is
  // "on Bash: bun test" would be the same lie the old renderer told.
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 2, active: () => true });
  const d = deps({ registry });
  const out = handleCommand("/status", 1, d)!;
  expect(out.text).toContain("working");
  expect(out.text).toContain("Bash: bun test");
  expect(out.text).toContain("last activity 4m ago");
  expect(out.text).toContain("2 queued");
});

test("/status shows ctx% for sessions with a persisted sdk session id", () => {
  const registry = createRegistry();
  const s = registry.add(order({ id: "cx", folder: "/p/gold", task: "t" }), 0);
  registry.setSdkSessionId(s.id, "sess-x");
  const d = deps({ registry });
  const out = handleCommand("/status", 1, { ...d, signals: () => ({ occupancy: 0.42, turns: 3, ageMs: 0, idleMs: 0 }) })!;
  expect(out.text).toContain("ctx 42%");
});

// 2026-07-23 review finding #4: /status's ctx% must be computed with the SAME windowTokensByModel
// override the keep/handoff/clear gates use — otherwise the displayed percentage can silently
// disagree with the gate's actual verdict.
test("/status threads cfg's windowTokensByModel into the signals call, same as the gates", () => {
  const registry = createRegistry();
  const s = registry.add(order({ id: "cx3", folder: "/p/gold", task: "t" }), 0);
  registry.setSdkSessionId(s.id, "sess-x");
  const d = deps({ registry });
  let seenOpts: { windowTokensByModel?: Record<string, number> } | undefined;
  const out = handleCommand("/status", 1, {
    ...d,
    windowTokensByModel: { "big-model": 1_000_000 },
    signals: (_folder, _id, opts) => {
      seenOpts = opts;
      return { occupancy: 0.42, turns: 3, ageMs: 0, idleMs: 0 };
    },
  })!;
  expect(out.text).toContain("ctx 42%");
  expect(seenOpts?.windowTokensByModel).toEqual({ "big-model": 1_000_000 });
});

test("/status shows ctx% via the default sessionContext (no signals injected)", () => {
  const registry = createRegistry();
  const s = registry.add(order({ id: "cx2", folder: "/p/gold-no-transcript", task: "t" }), 0);
  registry.setSdkSessionId(s.id, "sess-does-not-exist");
  const d = deps({ registry });
  const out = handleCommand("/status", 1, d)!; // no `signals` override — must fall back to sessionContext
  expect(out.text).toContain("ctx 0%");
});

// /list must speak the same vocabulary as `sessions` and dispatch: the DERIVED state, never the
// registry's lifetime `status` (which reads "running" for a session doing nothing at all).
test("/list reports the derived session state, not the registry lifecycle word", () => {
  const registry = createRegistry();
  const s = registry.add(order({ folder: "/p/alpha" }), 0);
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false });
  registry.noteActivity(s.id, "waiting", 0);

  const out = handleCommand("/list", 1, deps({ registry, now: () => 10 * 60 * 60 * 1000 }))!.text;
  expect(out).toContain("idle");
  expect(out).toContain("nothing in flight");
  expect(out).not.toContain("running");
});

test("/list shows a working project's activity and its last-activity age", () => {
  const registry = createRegistry();
  const s = registry.add(order({ folder: "/p/alpha" }), 0);
  registry.attachControl(s.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => true });
  registry.noteActivity(s.id, "Bash: bun test", 100_000);

  const out = handleCommand("/list", 1, deps({ registry, now: () => 110_000 }))!.text;
  expect(out).toContain("working");
  expect(out).toContain("Bash: bun test");
  expect(out).toContain("last activity 10s ago");
});

test("/list's icon follows the derived state — a wedged project is not a green dot", () => {
  const registry = createRegistry();
  const idle = registry.add(order({ folder: "/p/alpha" }), 0);
  registry.attachControl(idle.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false });
  const stuck = registry.add(order({ folder: "/p/beta" }), 0);
  registry.attachControl(stuck.id, { followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => true });

  const out = handleCommand("/list", 1, deps({ registry, now: () => 30 * 60 * 1000 }))!.text;
  const alpha = out.split("\n").find((l) => l.includes("alpha"))!;
  const beta = out.split("\n").find((l) => l.includes("beta"))!;
  expect(alpha).not.toContain("🟢"); // idle between turns — free, not busy
  expect(beta).toContain("🔴"); // wedged — the only row worth acting on
});

function fakeUpdater(running = false) {
  const calls: unknown[] = [];
  return {
    calls,
    updater: {
      status: () => "STATUS",
      running: () => running,
      run: async (o: unknown) => (calls.push(["run", o]), "report"),
      rollback: async (id: string) => (calls.push(["rollback", id]), "rolled"),
    },
  };
}

test("/updates shows the updater status; unavailable without one", () => {
  const f = fakeUpdater();
  expect(handleCommand("/updates", 1, { ...deps(), updates: f.updater })!.text).toBe("STATUS");
  expect(handleCommand("/updates", 1, deps())!.text).toContain("unavailable");
});

test("/updates run starts a manual run; a run in progress is not doubled", () => {
  const f = fakeUpdater();
  expect(handleCommand("/updates run", 1, { ...deps(), updates: f.updater })!.text).toContain("started");
  expect(f.calls).toEqual([["run", { trigger: "manual" }]]);
  const busy = fakeUpdater(true);
  expect(handleCommand("/updates run", 1, { ...deps(), updates: busy.updater })!.text).toContain("in progress");
  expect(busy.calls).toEqual([]);
});

test("/updates apply <item> forces that one item; rollback <item> rolls it back; bad input shows usage", () => {
  const f = fakeUpdater();
  handleCommand("/updates apply codebase-memory-mcp", 1, { ...deps(), updates: f.updater });
  handleCommand("/updates rollback npm:@playwright/mcp", 1, { ...deps(), updates: f.updater });
  expect(f.calls).toEqual([
    ["run", { trigger: "manual", only: "codebase-memory-mcp", force: true }],
    ["rollback", "npm:@playwright/mcp"],
  ]);
  expect(handleCommand("/updates apply", 1, { ...deps(), updates: f.updater })!.text).toContain("Usage");
  expect(handleCommand("/updates nonsense x", 1, { ...deps(), updates: f.updater })!.text).toContain("Usage");
  expect(f.calls.length).toBe(2);
});

// ADR-0014: /status shows where each session sits against the sweet spot, and its last reset.
const BANDS = { sweetSpotPct: 0.4, checkpointPct: 0.6, emergencyPct: 0.9 };

test("/status names the context band outside the sweet spot, and nothing inside it", () => {
  const registry = createRegistry();
  const a = registry.add(order({ id: "b1", folder: "/p/gold", task: "t" }), 0);
  registry.setSdkSessionId(a.id, "sess-a");
  const d = deps({ registry });
  const at = (occupancy: number) => handleCommand("/status", 1, { ...d, contextPolicy: BANDS, signals: () => ({ occupancy, turns: 3, ageMs: 0, idleMs: 0 }) })!.text;
  expect(at(0.2)).toContain("ctx 20% ·");
  expect(at(0.52)).toContain("ctx 52% above");
  expect(at(0.65)).toContain("ctx 65% heavy");
  expect(at(0.93)).toContain("ctx 93% EMERGENCY");
});

test("/status shows the project's last context reset with its reason", () => {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  const a = registry.add(order({ id: "b2", folder: "/p/gold", task: "t" }), 0);
  registry.setSdkSessionId(a.id, "sess-b");
  ledger.recordContextEvent("/p/gold", "handoff", 0.52, 10_000 - 2 * 3_600_000, { reason: "above-sweet-spot", boundary: "settled" });
  const d = deps({ registry, ledger, now: () => 10_000 });
  const out = handleCommand("/status", 1, { ...d, contextPolicy: BANDS, signals: () => ({ occupancy: 0.1, turns: 3, ageMs: 0, idleMs: 0 }) })!.text;
  expect(out).toContain("↻ handoff 2h ago (above-sweet-spot)");
});
