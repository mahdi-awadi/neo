import { test, expect } from "bun:test";
import { createRegistry } from "../src/engine/registry";
import { sweepStuck } from "../src/engine/watchdog";
import type { SessionInfo } from "../src/types";

function mk(now = 0) {
  const r = createRegistry();
  const s = r.add({ id: "w1", source: "neo", folder: "/p", task: "t", chatId: 1, createdAt: now }, now);
  return { r, s };
}
const OPTS = { stuckAfterMs: 600_000, longTurnAlertMs: 1_200_000, alertRepeatMs: 900_000 };

test("alerts once when a running session is silent past stuckAfterMs, with dedup + re-alert", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  const alerts: string[] = [];
  const alert = (_s: SessionInfo, reason: string) => void alerts.push(reason);
  expect(sweepStuck(r, { ...OPTS, now: 300_000, alert })).toHaveLength(0); // not yet
  expect(sweepStuck(r, { ...OPTS, now: 700_000, alert })).toHaveLength(1); // silent 700s > 600s
  expect(alerts[0]).toContain("silent");
  expect(sweepStuck(r, { ...OPTS, now: 800_000, alert })).toHaveLength(0); // deduped
  expect(sweepStuck(r, { ...OPTS, now: 1_700_000, alert })).toHaveLength(1); // re-alert after alertRepeatMs
});

test("alerts when one activity label grinds past longTurnAlertMs even with recent output", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.noteActivity(s.id, "dispatch: gold", 0);
  r.touch(s.id, 1_250_000); // recent output -> not "silent"
  const alerts: string[] = [];
  const out = sweepStuck(r, { ...OPTS, now: 1_300_000, alert: (_s, reason) => void alerts.push(reason) });
  expect(out).toHaveLength(1);
  expect(alerts[0]).toContain("dispatch: gold");
});

test("never alerts on idle sessions or after errors in the alert callback", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "idle");
  expect(sweepStuck(r, { ...OPTS, now: 10_000_000, alert: () => { throw new Error("boom"); } })).toHaveLength(0);
  r.setStatus(s.id, "running");
  // alert throws -> caught, still counted as alerted (no crash, no throw out of sweepStuck)
  expect(() => sweepStuck(r, { ...OPTS, now: 10_000_000, alert: () => { throw new Error("boom"); } })).not.toThrow();
});
