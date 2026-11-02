// The report tool's pure core (W1.1): a claim is accepted only when it has the shape the engine can verify.
import { test, expect } from "bun:test";
import { CLAIM_LIMITS, checkClaim, claimLine, type ClaimInput } from "../src/engine/report-tool";

const good: ClaimInput = {
  status: "ready",
  summary: "  The login page shows the new   error text. ",
  ran: [{ cmd: "bun test", exit: 0 }, { cmd: "bunx tsc --noEmit", exit: 0 }],
  changed: ["src/login.ts", "src/login.ts", " tests/login.test.ts "],
  ref: { commit: "abc1234" },
  risks: [],
  assumptions: ["the copy is final"],
};

test("a well-formed claim is normalised: trimmed, deduplicated, whitespace collapsed", () => {
  const r = checkClaim(good);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.claim.summary).toBe("The login page shows the new error text.");
  expect(r.claim.changed).toEqual(["src/login.ts", "tests/login.test.ts"]);
  expect(r.claim.ref).toEqual({ commit: "abc1234" });
  expect(r.claim.evidence).toEqual([]);
  expect(claimLine(r.claim)).toBe("claim ready: The login page shows the new error text. · ran 2 (2 ok) · abc1234");
});

test("every problem is named at once, so one retry fixes them all", () => {
  const r = checkClaim({ ...good, summary: "", ran: [{ cmd: "bun test", exit: 1 }], ref: { pr: 0 } });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.problems).toHaveLength(3);
  expect(r.problems.join("\n")).toContain("`summary` is empty");
  expect(r.problems.join("\n")).toContain("exited non-zero");
  expect(r.problems.join("\n")).toContain("`ref.pr` must be a real PR number");
});

test("ready needs something in ran; a hash in the summary is refused; an empty ref object is refused", () => {
  expect(checkClaim({ ...good, ran: [] })).toMatchObject({ ok: false });
  const hash = checkClaim({ ...good, summary: "Fixed in 0123456789abcdef0123" });
  expect(hash.ok).toBe(false);
  if (!hash.ok) expect(hash.problems[0]).toContain("commit hash");
  const empty = checkClaim({ ...good, ref: {} });
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.problems[0]).toContain("`ref` is an empty object");
});

test("no_change_needed needs evidence; handback needs a reason, and a reason without handback is refused", () => {
  expect(checkClaim({ ...good, status: "no_change_needed", ran: [] })).toMatchObject({ ok: false });
  const withEvidence = checkClaim({ ...good, status: "no_change_needed", ran: [], evidence: [{ kind: "test", ref: "login.test.ts: already covers it" }] });
  expect(withEvidence.ok).toBe(true);
  expect(checkClaim({ ...good, status: "handback", ran: [] })).toMatchObject({ ok: false });
  expect(checkClaim({ ...good, status: "handback", ran: [], handback: { reason: "this is the billing service's change" } })).toMatchObject({ ok: true });
  const stray = checkClaim({ ...good, handback: { reason: "x" } });
  expect(stray.ok).toBe(false);
  if (!stray.ok) expect(stray.problems[0]).toContain("status is not handback");
});

test("caps hold: a long summary and too many items are named, not silently cut", () => {
  const long = checkClaim({ ...good, summary: "x".repeat(CLAIM_LIMITS.summary + 1) });
  expect(long.ok).toBe(false);
  if (!long.ok) expect(long.problems[0]).toContain(`at most ${CLAIM_LIMITS.summary}`);
  const many = checkClaim({ ...good, changed: Array.from({ length: CLAIM_LIMITS.items + 1 }, (_, i) => `f${i}.ts`) });
  expect(many.ok).toBe(false);
  if (!many.ok) expect(many.problems[0]).toContain(`at most ${CLAIM_LIMITS.items}`);
});

test("blocked and failed claims may run nothing; dropped may have no ref", () => {
  expect(checkClaim({ ...good, status: "blocked", ran: [], summary: "I need the staging database password." })).toMatchObject({ ok: true });
  expect(checkClaim({ ...good, status: "failed", ran: [{ cmd: "bun test", exit: 1 }], ref: null })).toMatchObject({ ok: true });
  expect(checkClaim({ ...good, status: "dropped", ran: [], ref: null, summary: "Could not reproduce; the report matches an already-fixed case." })).toMatchObject({ ok: true });
});
