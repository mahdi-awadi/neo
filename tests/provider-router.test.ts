import { test, expect } from "bun:test";
import { route } from "../src/engine/provider-router";
import type { NeoConfig } from "../src/config";
import { DEFAULT_FAULTS, DEFAULT_HEALTH, DEFAULT_MODELS, DEFAULT_UPDATES } from "../src/config";
import type { Order, Provider } from "../src/types";

function cfg(over: Partial<{ ownWork: Provider; customerWork: Provider }> = {}): NeoConfig {
  return {
    telegramToken: "",
    telegramAllowFrom: [],
    geminiApiKey: "",
    botUsername: "",
    webHost: "127.0.0.1",
    webPort: 3003,
    publicUrl: "",
    companyFolder: "/tmp/agent",
    gatewaySendUrl: "",
    providers: { ownWork: "subscription", customerWork: "gemini", ...over },
    subscriptionInteractiveReservePct: 0.2,
    workRoot: "/home",
    budgetWindowUsd: 20,
    budgetWindowMs: 18_000_000,
    agentIngressSecret: "",
    idleCloseMs: 24 * 60 * 60 * 1000,
    stitchApiKey: "",
    codebaseMemoryBin: "",
    codebaseMemoryIndexTimeoutMs: 300_000,
    meetingLink: "",
    businessName: "",
    loopSchedulerEnabled: true,
    dispatchStallMs: 300_000,
    dispatchGraceMs: 75_000,
    dispatchProgressMs: 600_000,
    dispatchRecoverWindowMs: 86_400_000,
    todoOnFailure: "continue",
    apiRetryLadderMs: [30_000, 120_000, 480_000],
    apiRetryJitterFrac: 0.2,
    apiCooldownMs: 60_000,
    routeKeep: 20_000,
    eventsKeep: 50_000,
    decisionsKeep: 5_000,
    secretaryCron: "0 8-22/2 * * *",
    secretaryStaleHours: 24,
    codebaseMemoryListTimeoutMs: 15_000,
    inboxListDefault: 100,
    webFeedWindow: 500,
    messageRoutesCacheCap: 2_000,
    stuckAfterMs: 600_000,
    longTurnAlertMs: 1_200_000,
    alertRepeatMs: 900_000,
    drainWindowMs: 90_000,
    trustNewProjects: false,
    contextPolicy: { handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000, staleResumePct: 0.35, cacheTtlFallbackMs: 3_600_000, cacheTtlMinObservations: 5 },
    models: DEFAULT_MODELS,
    updates: DEFAULT_UPDATES,
    faults: DEFAULT_FAULTS,
    health: DEFAULT_HEALTH,
    sqliteBusyTimeoutMs: 5_000,
    workers: { company: { effort: "low" }, project: {}, dispatch: {}, loop: {}, judge: {}, ingress: { effort: "low" }, handoff: {}, secretary: {} },
    workerEnv: {},
    memory: { scopes: [], snapshotMaxPct: 0.004, userMaxPct: 0.0025, dreamMaxMutations: 3, dreamMaxAdds: 1, dreamMaxNetChars: 250, dreamLookbackDays: 14 },
    telegramToolSteps: false,
    telegramFloodMaxWaitMs: 30_000,
  };
}

function order(source: "neo" | "customer"): Order {
  return { id: "x", source, folder: "/tmp", task: "t", chatId: 1, createdAt: 1 };
}

test("route sends Neo's own work to the configured provider (default subscription)", () => {
  expect(route(order("neo"), cfg())).toEqual({ provider: "subscription" });
});

test("route is config-driven for own work (ownWork=gemini)", () => {
  expect(route(order("neo"), cfg({ ownWork: "gemini" }))).toEqual({ provider: "gemini" });
});

test("route can select Codex SDK for Neo's own work", () => {
  expect(route(order("neo"), cfg({ ownWork: "codex" }))).toEqual({ provider: "codex" });
});

test("route refuses customer-direct work in the MVP (Gemini path is Phase 3)", () => {
  const r = route(order("customer"), cfg());
  expect("refuse" in r).toBe(true);
});

test("FIREWALL: customer work never routes to the subscription, even if misconfigured", () => {
  const r = route(order("customer"), cfg({ customerWork: "subscription" }));
  expect(r).not.toEqual({ provider: "subscription" });
  expect("refuse" in r).toBe(true);
});
