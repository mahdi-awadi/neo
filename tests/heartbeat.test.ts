import { test, expect } from "bun:test";
import { heartbeatMs, CRON_RESOLUTION_MS } from "../src/engine/heartbeat";

test("heartbeat derives from enabled triggers: cron resolution by default, faster only if a shorter interval loop is enabled", () => {
  expect(heartbeatMs([])).toBe(CRON_RESOLUTION_MS); // nothing enabled → cron resolution floor
  expect(heartbeatMs([{ enabled: true, trigger: { kind: "cron", expr: "0 6 * * *" } }])).toBe(CRON_RESOLUTION_MS);
  expect(heartbeatMs([{ enabled: true, trigger: { kind: "interval", everyMs: 30_000 } }])).toBe(30_000);
  expect(heartbeatMs([{ enabled: false, trigger: { kind: "interval", everyMs: 5_000 } }])).toBe(CRON_RESOLUTION_MS); // disabled loops don't drive the tick
});
