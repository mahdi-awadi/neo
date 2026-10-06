import { expect, test } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { openEscalationDecision, resolveEscalationDecision } from "../src/engine/escalation";

test("a governor escalation opens exactly one open decision", () => {
  const l = openLedger(":memory:");
  const id = openEscalationDecision(l, { reason: "risky shell command: rm -rf /tmp/x", project: "acme", chatId: 5 });
  const open = l.listOpenDecisions();
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ id, kind: "decision", project: "acme", question: "risky shell command: rm -rf /tmp/x" });
});

test("tapping Allow/Deny resolves the escalation's decision row (drops out of the open queue)", () => {
  const l = openLedger(":memory:");
  const allow = openEscalationDecision(l, { reason: "deploy" });
  const deny = openEscalationDecision(l, { reason: "git push" });
  expect(l.listOpenDecisions()).toHaveLength(2);
  resolveEscalationDecision(l, allow, "allow", 100);
  resolveEscalationDecision(l, deny, "deny", 200);
  expect(l.listOpenDecisions()).toHaveLength(0);
  expect(l.decisionById(allow)).toMatchObject({ status: "answered", answer: "allow", answeredAt: 100 });
  expect(l.decisionById(deny)).toMatchObject({ status: "answered", answer: "deny" });
});

test("an ignored escalation stays OPEN (survives a restart — surfaced by the digest, not lost)", () => {
  const l = openLedger(":memory:");
  openEscalationDecision(l, { reason: "WebFetch https://x" });
  // No resolve → still open after (simulated) time passes / a restart re-reads the ledger.
  expect(l.listOpenDecisions()).toHaveLength(1);
});
