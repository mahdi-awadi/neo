// 2026-07-25 issue 4: a typed answer to an Allow/Deny prompt used to be queued as a follow-up the
// parked worker could never read. These pin how a typed message answers a pending approval.
import { test, expect } from "bun:test";
import { answerTypedApproval, createPendingApprovals, parseApprovalReply } from "../src/engine/approval-reply";

test("plain yes/no words map to allow/deny; anything else is not an answer", () => {
  for (const t of ["yes", "Yes!", "y", "ok", "allow", "approve", "go ahead", "yes please", "👍", "sure."]) expect(parseApprovalReply(t)).toBe("allow");
  for (const t of ["no", "No.", "n", "deny", "nope", "stop", "no thanks", "👎", "don't"]) expect(parseApprovalReply(t)).toBe("deny");
  for (const t of ["what does it do?", "fix the tests first", "yes but first tell me which file it writes to", ""]) expect(parseApprovalReply(t)).toBeUndefined();
});

test("with one approval pending, a typed yes answers it", () => {
  const store = createPendingApprovals();
  let got: string | undefined;
  const token = store.add(7, "Write outside the folder: /etc/hosts", (d) => (got = d));
  const r = answerTypedApproval(store, { chatId: 7, text: "yes" });
  expect(r.kind).toBe("answered");
  if (r.kind === "answered") {
    expect(r.decision).toBe("allow");
    expect(r.approval.token).toBe(token);
  }
  expect(got).toBe("allow");
  expect(store.forChat(7)).toEqual([]); // consumed — the buttons can't answer it twice
});

test("quote-replying to the approval prompt answers that one, even with several pending", () => {
  const store = createPendingApprovals();
  const seen: string[] = [];
  const a = store.add(7, "first", (d) => seen.push(`a:${d}`));
  const b = store.add(7, "second", (d) => seen.push(`b:${d}`));
  store.setMessageId(a, 100);
  store.setMessageId(b, 101);
  const r = answerTypedApproval(store, { chatId: 7, text: "no", replyToMessageId: 101 });
  expect(r.kind).toBe("answered");
  expect(seen).toEqual(["b:deny"]);
  expect(store.forChat(7).map((p) => p.reason)).toEqual(["first"]);
});

test("a bare yes with several approvals pending asks which one instead of guessing", () => {
  const store = createPendingApprovals();
  const seen: string[] = [];
  store.add(7, "first", (d) => seen.push(d));
  store.add(7, "second", (d) => seen.push(d));
  const r = answerTypedApproval(store, { chatId: 7, text: "yes" });
  expect(r.kind).toBe("remind");
  expect(seen).toEqual([]);
});

test("a non-yes/no reply to the approval prompt is re-prompted, not swallowed as a follow-up", () => {
  const store = createPendingApprovals();
  const t = store.add(7, "WebFetch https://x", () => {});
  store.setMessageId(t, 100);
  const r = answerTypedApproval(store, { chatId: 7, text: "what is it fetching?", replyToMessageId: 100 });
  expect(r.kind).toBe("remind");
  if (r.kind === "remind") expect(r.text).toContain("yes");
});

test("other messages pass through, carrying a reminder while an approval is still waiting", () => {
  const store = createPendingApprovals();
  store.add(7, "WebFetch https://x", () => {});
  const r = answerTypedApproval(store, { chatId: 7, text: "also check the logs" });
  expect(r.kind).toBe("pass");
  if (r.kind === "pass") expect(r.reminder).toContain("WebFetch https://x");
  const other = answerTypedApproval(store, { chatId: 8, text: "yes" });
  expect(other).toEqual({ kind: "pass" }); // a different chat has nothing pending
});

test("a button press and a typed answer can't both resolve the same approval", () => {
  const store = createPendingApprovals();
  const seen: string[] = [];
  const t = store.add(7, "x", (d) => seen.push(d));
  expect(store.take(t)?.reason).toBe("x");
  expect(answerTypedApproval(store, { chatId: 7, text: "no" })).toEqual({ kind: "pass" });
  expect(store.take(t)).toBeUndefined();
});
