import { test, expect } from "bun:test";
import { loadConfig } from "../src/config";

test("loadConfig defaults encode the compliance firewall", () => {
  // No config.json / .env in a nonexistent dir -> pure defaults.
  const cfg = loadConfig("/nonexistent-neo-dir-xyz");
  expect(cfg.providers.ownWork).toBe("subscription");
  expect(cfg.providers.customerWork).toBe("gemini");
  expect(cfg.subscriptionInteractiveReservePct).toBeGreaterThan(0);
  expect(cfg.subscriptionInteractiveReservePct).toBeLessThan(1);
});
