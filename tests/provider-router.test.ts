import { test, expect } from "bun:test";
import { route } from "../src/engine/provider-router";
import type { NeoConfig } from "../src/config";
import type { Order, Provider } from "../src/types";

function cfg(over: Partial<{ ownWork: Provider; customerWork: Provider }> = {}): NeoConfig {
  return {
    telegramToken: "",
    telegramAllowFrom: [],
    geminiApiKey: "",
    providers: { ownWork: "subscription", customerWork: "gemini", ...over },
    subscriptionInteractiveReservePct: 0.2,
    workRoot: "/home",
    budgetWindowUsd: 20,
    budgetWindowMs: 18_000_000,
    agentIngressSecret: "",
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
