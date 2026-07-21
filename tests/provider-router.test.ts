import { test, expect } from "bun:test";
import { route } from "../src/engine/provider-router";
import type { NeoConfig } from "../src/config";
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
    gitnexusBin: "",
    codebaseMemoryBin: "",
    codebaseMemoryIndexTimeoutMs: 300_000,
    meetingLink: "",
    businessName: "",
    loopSchedulerEnabled: true,
    dispatchTimeoutMs: 900_000,
    dispatchTimeoutMaxMs: 7_200_000,
    dispatchStallMs: 300_000,
    dispatchGraceMs: 75_000,
    stuckAfterMs: 600_000,
    longTurnAlertMs: 1_200_000,
    alertRepeatMs: 900_000,
    drainWindowMs: 90_000,
    contextPolicy: { handoffPct: 0.65, emergencyPct: 0.85, maxTurns: 200, maxAgeMs: 604_800_000, handoffTimeoutMs: 180_000 },
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

test("route refuses customer-direct work in the MVP (Gemini path is Phase 3)", () => {
  const r = route(order("customer"), cfg());
  expect("refuse" in r).toBe(true);
});

test("FIREWALL: customer work never routes to the subscription, even if misconfigured", () => {
  const r = route(order("customer"), cfg({ customerWork: "subscription" }));
  expect(r).not.toEqual({ provider: "subscription" });
  expect("refuse" in r).toBe(true);
});
