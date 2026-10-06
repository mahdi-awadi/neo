import { test, expect } from "bun:test";
import { createRegistry } from "../src/engine/registry";
import { sweepStuck } from "../src/engine/watchdog";
import type { SessionControl, SessionInfo } from "../src/types";

function mk(now = 0) {
  const r = createRegistry();
  const s = r.add({ id: "w1", source: "neo", folder: "/p", task: "t", chatId: 1, createdAt: now }, now);
  return { r, s };
}
const OPTS = { stuckAfterMs: 600_000, longTurnAlertMs: 1_200_000, alertRepeatMs: 900_000 };
const control = (over: Partial<SessionControl> = {}): SessionControl => ({
  followUp: () => {},
  interrupt: async () => {},
  queued: () => 0,
  active: () => true,
  ...over,
});

test("alerts once when an in-turn session shows NO ACTIVITY past stuckAfterMs, with dedup + re-alert", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.attachControl(s.id, control());
  const alerts: string[] = [];
  const alert = (_s: SessionInfo, reason: string) => void alerts.push(reason);
  expect(sweepStuck(r, { ...OPTS, now: 300_000, alert })).toHaveLength(0); // not yet
  expect(sweepStuck(r, { ...OPTS, now: 700_000, alert })).toHaveLength(1); // silent 700s > 600s
  expect(alerts[0]).toContain("no activity");
  expect(sweepStuck(r, { ...OPTS, now: 800_000, alert })).toHaveLength(0); // deduped
  expect(sweepStuck(r, { ...OPTS, now: 1_700_000, alert })).toHaveLength(1); // re-alert after alertRepeatMs
});

// The old watchdog judged "silence" by operator-visible output, so a worker mid-generation (a long
// turn writing one huge file) was alerted on as stuck. ANY streamed event is proof of life.
test("a heartbeat alone keeps an in-turn session out of the alert, with no output at all", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.attachControl(s.id, control());
  r.noteActivity(s.id, "Write: giant-file.ts", 0);
  for (let t = 0; t <= 1_000_000; t += 100_000) r.noteHeartbeat(s.id, t); // partial deltas only
  const alerts: string[] = [];
  expect(sweepStuck(r, { ...OPTS, now: 1_050_000, alert: (_s, reason) => void alerts.push(reason) })).toHaveLength(0);
});

test("a long-but-alive turn is an FYI, never reported as wedged", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.attachControl(s.id, control());
  r.noteActivity(s.id, "Write: giant-file.ts", 0);
  for (let t = 0; t <= 2_000_000; t += 100_000) r.noteHeartbeat(s.id, t);
  const alerts: string[] = [];
  sweepStuck(r, { ...OPTS, now: 2_050_000, alert: (_s, reason) => void alerts.push(reason) });
  expect(alerts[0]).toContain("still producing activity");
  expect(alerts[0]).not.toContain("wedged");
});

test("alerts when one activity label grinds past longTurnAlertMs even while it keeps pulsing", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.attachControl(s.id, control());
  r.noteActivity(s.id, "dispatch: gold", 0);
  r.noteHeartbeat(s.id, 1_250_000); // alive -> not "no activity"
  const alerts: string[] = [];
  const out = sweepStuck(r, { ...OPTS, now: 1_300_000, alert: (_s, reason) => void alerts.push(reason) });
  expect(out).toHaveLength(1);
  expect(alerts[0]).toContain("dispatch: gold");
  expect(alerts[0]).toContain("still producing activity"); // an FYI, not a "it is stuck" claim
});

test("never alerts a session that is sitting between turns, however old", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.attachControl(s.id, control({ active: () => false }));
  r.noteActivity(s.id, "waiting", 0);
  const alerts: string[] = [];
  const alert = (_s: SessionInfo, reason: string) => void alerts.push(reason);
  expect(sweepStuck(r, { ...OPTS, now: 10_000_000, alert })).toHaveLength(0);
});

// The old blanket exemption was on the LABEL ("waiting"), which made a session wedged AT a turn
// boundary permanently invisible. The exemption must be on the turn state, not the label.
test("alerts a session whose label is 'waiting' but whose turn is genuinely in flight and silent", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.attachControl(s.id, control());
  r.noteActivity(s.id, "waiting", 0);
  const alerts: string[] = [];
  expect(sweepStuck(r, { ...OPTS, now: 700_000, alert: (_s, reason) => void alerts.push(reason) })).toHaveLength(1);
});

test("never alerts a session that is waiting on the operator", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.attachControl(s.id, control());
  r.noteBlocked(s.id, { kind: "approval", label: "Write outside project", since: 0 });
  const alerts: string[] = [];
  const alert = (_s: SessionInfo, reason: string) => void alerts.push(reason);
  expect(sweepStuck(r, { ...OPTS, now: 10_000_000, alert })).toHaveLength(0);
});

test("alerts when a session never got its worker attached (a dead prepare step)", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running"); // registered, no control ever attached
  const alerts: string[] = [];
  const out = sweepStuck(r, { ...OPTS, now: 700_000, alert: (_s, reason) => void alerts.push(reason) });
  expect(out).toHaveLength(1);
  expect(alerts[0]).toContain("no worker");
});

test("records the evidence behind an alert before raising it", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.attachControl(s.id, control());
  r.noteActivity(s.id, "Bash: cp -i a b", 0);
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  sweepStuck(r, {
    ...OPTS,
    now: 700_000,
    alert: () => {},
    record: (kind, data) => void events.push({ kind, data }),
  });
  expect(events[0]!.kind).toBe("session_stuck");
  expect(events[0]!.data).toMatchObject({ state: "wedged", activity: "Bash: cp -i a b", stdinWait: true });
});

test("a stdin-wait suspect is named in the alert so the hang is diagnosable", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "running");
  r.attachControl(s.id, control());
  r.noteActivity(s.id, "Bash: cp -i a b", 0);
  const alerts: string[] = [];
  sweepStuck(r, { ...OPTS, now: 700_000, alert: (_s, reason) => void alerts.push(reason) });
  expect(alerts[0]).toContain("stdin");
});

test("never alerts on closed sessions or after errors in the alert callback", () => {
  const { r, s } = mk(0);
  r.setStatus(s.id, "idle");
  expect(sweepStuck(r, { ...OPTS, now: 10_000_000, alert: () => { throw new Error("boom"); } })).toHaveLength(0);
  r.setStatus(s.id, "running");
  // alert throws -> caught, still counted as alerted (no crash, no throw out of sweepStuck)
  expect(() => sweepStuck(r, { ...OPTS, now: 10_000_000, alert: () => { throw new Error("boom"); } })).not.toThrow();
});
