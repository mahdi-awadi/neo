// A pending approval must never wait silently forever (ADR-0012). While the operator has not
// answered, `patientApproval` reminds them every `approvalRemindMs`; after `approvalTimeoutMs` it
// fails CLOSED (deny), tells the operator, and aborts the frontend's prompt. 0 turns either off.
import { test, expect } from "bun:test";
import { patientApproval } from "../src/engine/escalation";
import type { Priority } from "../src/engine/priority";

type Said = { text: string; priority: Priority };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an answered approval returns the operator's decision and sends nothing extra", async () => {
  const said: Said[] = [];
  const d = await patientApproval(async () => "allow", "risky shell command: git push", {
    patience: { approvalRemindMs: 1_000, approvalTimeoutMs: 5_000 },
    say: (text, priority) => said.push({ text, priority }),
  });
  expect(d).toBe("allow");
  expect(said).toEqual([]);
});

test("a long wait re-notifies the operator on the Decisions surface", async () => {
  const said: Said[] = [];
  let answer!: (d: "allow" | "deny") => void;
  const p = patientApproval(() => new Promise((r) => (answer = r)), "risky shell command: git push", {
    patience: { approvalRemindMs: 15, approvalTimeoutMs: 0 },
    say: (text, priority) => said.push({ text, priority }),
  });
  await sleep(50);
  answer("allow");
  expect(await p).toBe("allow");
  expect(said.length).toBeGreaterThanOrEqual(2);
  expect(said[0]!.priority).toBe("decision");
  expect(said[0]!.text).toContain("risky shell command: git push");
  // No more reminders after the answer.
  const n = said.length;
  await sleep(40);
  expect(said.length).toBe(n);
});

test("an unanswered approval times out to DENY, alerts the operator, and aborts the prompt", async () => {
  const said: Said[] = [];
  const events: string[] = [];
  let aborted = false;
  const d = await patientApproval(
    (signal) =>
      new Promise(() => {
        signal.addEventListener("abort", () => (aborted = true));
      }),
    "risky shell command: deploy",
    {
      patience: { approvalRemindMs: 0, approvalTimeoutMs: 20 },
      say: (text, priority) => said.push({ text, priority }),
      record: (kind) => events.push(kind),
    },
  );
  expect(d).toBe("deny");
  expect(aborted).toBe(true);
  expect(said).toHaveLength(1);
  expect(said[0]!.priority).toBe("alert");
  expect(said[0]!.text).toContain("risky shell command: deploy");
  expect(events).toEqual(["approval_timeout"]);
});

test("0/0 keeps today's behaviour: wait for the operator, no reminders", async () => {
  const said: Said[] = [];
  let answer!: (d: "allow" | "deny") => void;
  const p = patientApproval(() => new Promise((r) => (answer = r)), "x", {
    patience: { approvalRemindMs: 0, approvalTimeoutMs: 0 },
    say: (text, priority) => said.push({ text, priority }),
  });
  await sleep(30);
  answer("deny");
  expect(await p).toBe("deny");
  expect(said).toEqual([]);
});

test("a rejecting prompt still rejects (the canUseTool fail-safe handles it) and clears its timers", async () => {
  const said: Said[] = [];
  await expect(
    patientApproval(async () => { throw new Error("Stream closed"); }, "x", {
      patience: { approvalRemindMs: 10, approvalTimeoutMs: 20 },
      say: (text, priority) => said.push({ text, priority }),
    }),
  ).rejects.toThrow("Stream closed");
  await sleep(40);
  expect(said).toEqual([]);
});
