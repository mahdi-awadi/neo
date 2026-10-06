import { test, expect } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { loadConfig } from "../src/config";
import { SECRETARY, resolveSecretaryLoop, secretaryGateOutcome } from "../src/engine/loops";

test("secretary gate is silent (0 iterations, no worker run) when the queue is empty", () => {
  const l = openLedger(":memory:");
  const out = secretaryGateOutcome(SECRETARY, l);
  expect(out?.iterations).toBe(0);
  expect(out?.met).toBe(false);
});

test("secretary gate proceeds (undefined → run the digest) when a decision is open", () => {
  const l = openLedger(":memory:");
  l.openDecision({ kind: "decision", question: "which db?" });
  expect(secretaryGateOutcome(SECRETARY, l)).toBeUndefined();
});

test("resolveSecretaryLoop interpolates the open queue into the prompt, resolves the folder, and stamps reminders", () => {
  const cfg = loadConfig();
  const l = openLedger(":memory:");
  l.openDecision({ kind: "decision", project: "acme", question: "which db?" });
  const def = resolveSecretaryLoop(SECRETARY, cfg, l);
  expect(def.prompt).not.toContain("{{OPEN_DECISIONS}}"); // placeholder rendered away
  expect(def.prompt).toContain("which db?"); // the real queue item is in the prompt
  expect(def.prompt).toContain("acme"); // grouped by project
  expect(def.folder).toBe(cfg.companyFolder); // sentinel resolved to the real company folder
  expect(def.trigger).toEqual({ kind: "cron", expr: cfg.secretaryCron }); // cadence from config
  expect(l.listOpenDecisions()[0]!.reminderCount).toBe(1); // the fire stamped a reminder
});

test("resolveSecretaryLoop stamps a reminder each fire (the operator keeps being reminded)", () => {
  const cfg = loadConfig();
  const l = openLedger(":memory:");
  l.openDecision({ kind: "decision", question: "need the prod key" });
  resolveSecretaryLoop(SECRETARY, cfg, l);
  resolveSecretaryLoop(SECRETARY, cfg, l);
  expect(l.listOpenDecisions()[0]!.reminderCount).toBe(2);
});

test("resolveSecretaryLoop without a ledger resolves folder/trigger but leaves the placeholder (no stamping)", () => {
  const cfg = loadConfig();
  const def = resolveSecretaryLoop(SECRETARY, cfg);
  expect(def.folder).toBe(cfg.companyFolder);
  expect(def.prompt).toContain("{{OPEN_DECISIONS}}"); // not interpolated without the queue
});

test("resolveSecretaryLoop is a no-op for a non-secretary loop", () => {
  const cfg = loadConfig();
  const l = openLedger(":memory:");
  const plain = { ...SECRETARY, secretary: false, prompt: "hello {{OPEN_DECISIONS}}" };
  expect(resolveSecretaryLoop(plain, cfg, l).prompt).toBe("hello {{OPEN_DECISIONS}}");
  expect(l.listOpenDecisions()).toHaveLength(0); // nothing opened, nothing stamped
});

test("the secretary loop is a registered, opt-in built-in", () => {
  expect(SECRETARY.secretary).toBe(true);
  expect(SECRETARY.enabledByDefault).toBe(false); // opt-in like the other loops
  expect(SECRETARY.bounds.maxIterations).toBe(1); // fire-once
});
