import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import {
  dispatchResultText,
  flushDispatcherInbox,
  formatStopPoint,
  lastCommitIn,
  liveCompanyLink,
  progressDigest,
  recoverInterruptedDispatches,
  takeDispatcherInbox,
  type DispatcherLink,
} from "../src/engine/dispatch-report";

/** Queue one result, then deliver the inbox — what dispatch does at the end of a run. */
async function reportToDispatcher(ledger: ReturnType<typeof openLedger>, link: DispatcherLink, project: string, text: string, now: number) {
  ledger.queueDispatcherReport(project, text, now);
  await flushDispatcherInbox(ledger, link, now);
}

const linkOf = (ok: boolean, sent: Array<{ text: string; wake: boolean }>): DispatcherLink => ({
  deliver: (text, opts) => {
    sent.push({ text, wake: opts.wake });
    return ok;
  },
});

// --- Formatting (pure) ---

test("progressDigest names the project, elapsed time, activity, last commit and latest note, and asks for no reply", () => {
  const t = progressDigest({
    project: "eticket-v3",
    elapsedMs: 47 * 60_000,
    activity: "Agent: Implement Task 6",
    lastCommit: "8694a46 feat: brand on GetOffer (3 minutes ago)",
    lastNote: "Task 5 is approved. Next, Task 6.",
  });
  expect(t).toContain("[dispatch progress] eticket-v3");
  expect(t).toContain("47m");
  expect(t).toContain("Agent: Implement Task 6");
  expect(t).toContain("8694a46");
  expect(t).toContain("Task 5 is approved");
  expect(t.toLowerCase()).toContain("no reply needed");
});

test("progressDigest renders hours for long runs and truncates a long note to one line", () => {
  const t = progressDigest({ project: "p", elapsedMs: 3 * 3_600_000 + 5 * 60_000, lastNote: "x".repeat(2000) + "\nsecond line" });
  expect(t).toContain("3h05m");
  expect(t.length).toBeLessThan(700);
  expect(t).not.toContain("second line");
});

test("formatStopPoint lists what is known and is empty when nothing is", () => {
  expect(formatStopPoint({})).toBe("");
  const s = formatStopPoint({ lastCommit: "abc123 fix", lastNote: "Task 4 done", lastActivity: "Bash: go test" });
  expect(s).toContain("stopped at");
  expect(s).toContain("abc123 fix");
  expect(s).toContain("Task 4 done");
  expect(s).toContain("Bash: go test");
});

test("dispatchResultText carries the summary, plus the stop point when one is given", () => {
  expect(dispatchResultText({ project: "p", ok: true, summary: "built it" })).toBe("[dispatch result] p: built it");
  expect(dispatchResultText({ project: "p", ok: false, summary: "" })).toBe("[dispatch result] p: failed");
  const t = dispatchResultText({ project: "p", ok: false, summary: "timed out: stall", stop: { lastCommit: "abc fix" } });
  expect(t).toContain("timed out: stall");
  expect(t).toContain("abc fix");
});

test("lastCommitIn reads the folder's HEAD commit and is undefined outside a git repo", () => {
  expect(lastCommitIn(mkdtempSync(join(tmpdir(), "neo-nogit-")))).toBeUndefined();
  const here = lastCommitIn(process.cwd()); // the repo under test
  expect(here).toMatch(/^[0-9a-f]{7,} /);
});

// --- Dispatcher inbox (durable) ---

test("a reported result is delivered (with wake) and then not delivered again", async () => {
  const ledger = openLedger(":memory:");
  const sent: Array<{ text: string; wake: boolean }> = [];
  await reportToDispatcher(ledger, linkOf(true, sent), "eticket-v3", "[dispatch result] eticket-v3: done", 1);
  expect(sent).toEqual([{ text: "[dispatch result] eticket-v3: done", wake: true }]);
  expect(ledger.pendingDispatcherReports()).toHaveLength(0);
  await flushDispatcherInbox(ledger, linkOf(true, sent), 2);
  expect(sent).toHaveLength(1);
});

test("an undeliverable result stays in the inbox and goes out with the next delivery, oldest first", async () => {
  const ledger = openLedger(":memory:");
  const sent: Array<{ text: string; wake: boolean }> = [];
  await reportToDispatcher(ledger, linkOf(false, sent), "a", "[dispatch result] a: one", 1);
  expect(ledger.pendingDispatcherReports()).toHaveLength(1);
  await reportToDispatcher(ledger, linkOf(true, sent), "b", "[dispatch result] b: two", 2);
  const last = sent[sent.length - 1]!;
  expect(last.text.indexOf("a: one")).toBeGreaterThanOrEqual(0);
  expect(last.text.indexOf("a: one")).toBeLessThan(last.text.indexOf("b: two"));
  expect(ledger.pendingDispatcherReports()).toHaveLength(0);
});

test("a link that throws leaves the report pending (never lost)", async () => {
  const ledger = openLedger(":memory:");
  const boom: DispatcherLink = {
    deliver: () => {
      throw new Error("down");
    },
  };
  await reportToDispatcher(ledger, boom, "a", "[dispatch result] a: one", 1);
  expect(ledger.pendingDispatcherReports()).toHaveLength(1);
});

test("takeDispatcherInbox returns pending reports once, for prepending to the dispatcher's next message", async () => {
  const ledger = openLedger(":memory:");
  await reportToDispatcher(ledger, linkOf(false, []), "a", "[dispatch result] a: one", 1);
  const block = takeDispatcherInbox(ledger, 2);
  expect(block).toContain("a: one");
  expect(takeDispatcherInbox(ledger, 3)).toBeUndefined();
});

test("liveCompanyLink delivers into a live company control, never wakes, and refuses a closing or draining one", () => {
  const registry = createRegistry();
  const co = registry.add({ id: "co", source: "neo", folder: "/x/agent", task: "hq", chatId: 1, createdAt: 0 }, 0);
  registry.setDefault(co.id);
  const got: string[] = [];
  // no control → not delivered (and no wake possible from the dispatch module)
  expect(liveCompanyLink(registry).deliver("r1", { wake: true })).toBe(false);
  let closed = false;
  registry.attachControl(co.id, { followUp: (t) => void got.push(t), interrupt: async () => {}, closed: () => closed });
  registry.setStatus(co.id, "running");
  expect(liveCompanyLink(registry).deliver("r2", { wake: false })).toBe(true);
  expect(got).toEqual(["r2"]);
  closed = true;
  expect(liveCompanyLink(registry).deliver("r3", { wake: false })).toBe(false);
  closed = false;
  expect(liveCompanyLink(registry, { draining: () => true }).deliver("r4", { wake: false })).toBe(false);
  expect(got).toEqual(["r2"]);
});

// --- Boot recovery: a dispatch the daemon never finished ---

test("recoverInterruptedDispatches closes a started-but-never-ended dispatch and queues a report with its stop point", () => {
  const ledger = openLedger(":memory:");
  ledger.recordEvent("dispatch_start", { orderId: "o1", folder: "/home/eticket-v3", data: { project: "eticket-v3" }, at: 1_000 });
  ledger.recordEvent("dispatch_start", { orderId: "o2", folder: "/home/waselni", data: { project: "waselni" }, at: 1_000 });
  ledger.recordEvent("dispatch_end", { orderId: "o2", folder: "/home/waselni", data: { project: "waselni", ok: true }, at: 2_000 });
  const n = recoverInterruptedDispatches(ledger, { now: 5_000, windowMs: 60_000, lastCommit: () => "abc123 task 4" });
  expect(n).toBe(1);
  const pending = ledger.pendingDispatcherReports();
  expect(pending).toHaveLength(1);
  expect(pending[0]!.text).toContain("eticket-v3");
  expect(pending[0]!.text).toContain("engine restart");
  expect(pending[0]!.text).toContain("abc123 task 4");
  const ends = ledger.listEvents({ kind: "dispatch_end" }).filter((e) => e.orderId === "o1");
  expect(ends).toHaveLength(1);
  expect(ends[0]!.data).toMatchObject({ ok: false, interrupted: "engine restart" });
  // idempotent: a second boot finds nothing left to recover
  expect(recoverInterruptedDispatches(ledger, { now: 6_000, windowMs: 60_000, lastCommit: () => undefined })).toBe(0);
});

test("recoverInterruptedDispatches ignores starts older than the recovery window", () => {
  const ledger = openLedger(":memory:");
  ledger.recordEvent("dispatch_start", { orderId: "old", folder: "/home/x", data: { project: "x" }, at: 1_000 });
  expect(recoverInterruptedDispatches(ledger, { now: 1_000_000, windowMs: 10_000, lastCommit: () => undefined })).toBe(0);
});
