import { expect, test } from "bun:test";
import {
  describeLiveness,
  livenessEvidence,
  looksLikeStdinWait,
  sessionState,
  DEFAULT_LIVENESS_THRESHOLDS,
  type LivenessSignals,
} from "../src/engine/liveness";
import type { Order, SessionInfo } from "../src/types";

const MIN = 60_000;

const order = (o: Partial<Order> = {}): Order => ({
  id: crypto.randomUUID(),
  source: "neo",
  folder: "/p/acme",
  task: "do a thing",
  chatId: 5,
  createdAt: 0,
  ...o,
});

const session = (s: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "1",
  name: "acme",
  sdkSessionId: "sdk",
  order: order(),
  status: "running",
  startedAt: 0,
  lastActivityAt: 0,
  lastOutputAt: 0,
  ...s,
});

const sig = (s: Partial<LivenessSignals> = {}): LivenessSignals => ({ inTurn: true, queued: 0, ...s });

const th = DEFAULT_LIVENESS_THRESHOLDS;

// AC1 — the incident: a worker streaming tool calls must never read as idle or wedged, however
// long its activity LABEL has been unchanged (the old renderer measured the label's age).
test("a session streaming activity is working, even when its label is hours old", () => {
  const s = session({
    activity: { label: "Bash: bun test", since: 0 }, // same label for 10h
    lastActivityAt: 10 * 60 * MIN - 1_000, // …but it pulsed a second ago
    lastOutputAt: 10 * 60 * MIN - 1_000,
  });
  expect(sessionState(s, sig(), th, 10 * 60 * MIN)).toBe("working");
});

// AC2 — between turns is healthy at ANY age. This is the line the company misread as "wedged".
test("a session between turns is idle at any age, never wedged", () => {
  const s = session({ activity: { label: "waiting", since: 0 }, lastActivityAt: 0, lastOutputAt: 0 });
  expect(sessionState(s, sig({ inTurn: false }), th, 10 * 60 * MIN)).toBe("idle");
});

// AC3 — the real fault: in-turn and genuinely silent.
test("an in-turn session with no activity past the threshold is wedged", () => {
  const s = session({ activity: { label: "Bash: cp -i a b", since: 0 }, lastActivityAt: 0, lastOutputAt: 0 });
  expect(sessionState(s, sig(), th, th.wedgedAfterMs)).toBe("wedged");
  expect(sessionState(s, sig(), th, th.wedgedAfterMs - 1)).not.toBe("wedged");
});

// AC4 — waiting on the operator is the operator's clock, not the worker's.
test("a session blocked on the operator is awaiting-operator, never wedged", () => {
  const s = session({
    lastActivityAt: 0,
    lastOutputAt: 0,
    blockedOn: { kind: "approval", label: "Write outside project", since: 0 },
  });
  expect(sessionState(s, sig(), th, 10 * 60 * MIN)).toBe("awaiting-operator");
});

test("a closed session is idle regardless of its clocks", () => {
  const s = session({ status: "idle", lastActivityAt: 0 });
  expect(sessionState(s, sig({ inTurn: true }), th, 10 * 60 * MIN)).toBe("idle");
});

// AC5 — alive but producing nothing the operator can read (a long build).
test("an in-turn session with activity but no output is quiet", () => {
  const s = session({ lastActivityAt: 9 * MIN, lastOutputAt: 0 });
  expect(sessionState(s, sig(), th, 9 * MIN + 1_000)).toBe("quiet");
});

// AC6 — the operator-facing line must carry BOTH ages and never the raw lifecycle word.
test("describeLiveness reports state, activity, both ages and the queue — never 'running'", () => {
  const s = session({
    activity: { label: "Bash: bun test", since: 0 },
    lastActivityAt: 4_000,
    lastOutputAt: 0,
    startedAt: 0,
  });
  const line = describeLiveness(s, sig({ queued: 2 }), th, 5_000);
  expect(line).toContain("working");
  expect(line).toContain("Bash: bun test");
  expect(line).toContain("last activity 1s ago");
  expect(line).toContain("last output 5s ago");
  expect(line).toContain("2 queued");
  expect(line).not.toContain("running");
});

test("describeLiveness names what an idle session is waiting for, not how long it 'ran'", () => {
  const s = session({ activity: { label: "waiting", since: 0 }, lastActivityAt: 0, lastOutputAt: 0 });
  const line = describeLiveness(s, sig({ inTurn: false }), th, 10 * 60 * MIN);
  expect(line).toContain("idle");
  expect(line).toContain("nothing in flight");
  expect(line).toContain("last activity 10h ago");
  expect(line).not.toContain("wedged");
});

test("describeLiveness says what a blocked session is blocked on and since when", () => {
  const s = session({ blockedOn: { kind: "decision", label: "Postgres or Mongo?", since: 0 } });
  const line = describeLiveness(s, sig(), th, 6 * MIN);
  expect(line).toContain("awaiting-operator");
  expect(line).toContain("Postgres or Mongo?");
  expect(line).toContain("blocked 6m");
});

// AC9 — an abort must be able to state the facts it acted on.
test("livenessEvidence carries the facts a stall/wedge decision was made on", () => {
  const s = session({
    activity: { label: "Bash: cp -i src dst", since: 0 },
    lastActivityAt: 0,
    lastOutputAt: 0,
  });
  const ev = livenessEvidence(s, sig({ queued: 1 }), th, 6 * MIN);
  expect(ev.state).toBe("wedged");
  expect(ev.lastActivityMs).toBe(6 * MIN);
  expect(ev.lastOutputMs).toBe(6 * MIN);
  expect(ev.activity).toBe("Bash: cp -i src dst");
  expect(ev.queued).toBe(1);
  expect(ev.inTurn).toBe(true);
  expect(ev.stdinWait).toBe(true); // cp -i will sit on a prompt forever
});

// AC10 — cheap, pure stdin-wait detection, for diagnosis only.
test("looksLikeStdinWait flags known interactive commands and leaves normal ones alone", () => {
  expect(looksLikeStdinWait("Bash: cp -i a b")).toBe(true);
  expect(looksLikeStdinWait("Bash: rm -i old")).toBe(true);
  expect(looksLikeStdinWait("Bash: git rebase -i HEAD~3")).toBe(true);
  expect(looksLikeStdinWait("Bash: npm init")).toBe(true);
  expect(looksLikeStdinWait("Bash: cp -r a b")).toBe(false);
  expect(looksLikeStdinWait("Bash: npm init -y")).toBe(false);
  expect(looksLikeStdinWait("Read: src/index.ts")).toBe(false);
  expect(looksLikeStdinWait(undefined)).toBe(false);
});

// A registered session whose worker handle isn't attached yet (the engine is still indexing the
// folder / running the context gate) is STARTING — not idle (it can't take a brief) and not wedged.
// Reporting it as "busy, no live handle" is what made healthy projects look broken.
test("a session with no worker attached yet is starting", () => {
  const s = session({ activity: { label: "preparing", since: 0 }, lastActivityAt: 0 });
  expect(sessionState(s, sig({ inTurn: false, hasWorker: false }), th, 70_000)).toBe("starting");
  const line = describeLiveness(s, sig({ inTurn: false, hasWorker: false }), th, 70_000);
  expect(line).toContain("starting");
  expect(line).toContain("preparing");
  expect(line).not.toContain("idle");
});

test("starting never outranks awaiting-operator or a closed session", () => {
  const blocked = session({ blockedOn: { kind: "approval", label: "x", since: 0 } });
  expect(sessionState(blocked, sig({ hasWorker: false }), th, 1_000)).toBe("awaiting-operator");
  const closed = session({ status: "idle" });
  expect(sessionState(closed, sig({ hasWorker: false }), th, 1_000)).toBe("idle");
});
