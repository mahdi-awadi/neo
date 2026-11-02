// Ending an API wait early (ADR-0060): a held run's re-send happens exactly once — when its timer ends,
// when `todo retry` wakes it, or never, when the run moved on by itself. Every end is on the ledger, so
// the limit-wait display (ADR-0047) stops showing it.
import { expect, test } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createApiWaits } from "../src/engine/api-wait";
import { apiWait, limitWait } from "../src/engine/api-retry";

const NOW = 1_800_000_000_000;

/** A delay the test resolves by hand. */
function manualDelay(): { delay: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const delay = new Promise<void>((r) => (fire = r));
  return { delay, fire };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const ledger = openLedger(":memory:");
  const waits = createApiWaits({ ledger, now: () => NOW });
  const held = (orderId: string, kind = "rate_limit", provider = "claude", ms = 3_600_000) => {
    ledger.recordEvent("api_retry", { orderId, at: NOW, data: { kind, delayMs: ms } });
    const d = manualDelay();
    const sent: string[] = [];
    waits.hold({ orderId, kind, provider, until: NOW + ms }, d.delay, () => sent.push(orderId));
    return { ...d, sent };
  };
  return { ledger, waits, held };
}

test("wake re-sends at once, exactly once: the timer firing later sends nothing", async () => {
  const { ledger, waits, held } = setup();
  const h = held("o1");
  expect(apiWait(ledger, "o1", NOW)).toEqual({ resumesAt: NOW + 3_600_000, limit: true });
  expect(waits.wake("o1", "retry")).toBe(true);
  expect(h.sent).toEqual(["o1"]);
  h.fire();
  await tick();
  expect(h.sent).toEqual(["o1"]);
  expect(waits.wake("o1", "retry")).toBe(false); // nothing held any more
  expect(limitWait(ledger, "o1", NOW + 1)).toBeUndefined(); // the display stops showing it
  expect(ledger.listEvents({ kind: "api_wait_ended", orderId: "o1" })[0]!.data).toMatchObject({ reason: "retry" });
});

test("the timer ends the wait as before; wake after that is refused", async () => {
  const { waits, held } = setup();
  const h = held("o1");
  h.fire();
  await tick();
  expect(h.sent).toEqual(["o1"]);
  expect(waits.held("o1")).toBeUndefined();
  expect(waits.wake("o1", "retry")).toBe(false);
});

test("drop: the run moved on by itself (the operator's Resume) — no re-send, ever", async () => {
  const { ledger, waits, held } = setup();
  const h = held("o1");
  expect(waits.drop("o1")).toBe(true);
  h.fire();
  await tick();
  expect(h.sent).toEqual([]);
  expect(limitWait(ledger, "o1", NOW + 1)).toBeUndefined();
  expect(waits.drop("o1")).toBe(false);
});

test("limitCleared wakes the other rate-limit holds of the same provider, each after its jitter", async () => {
  const { waits, held } = setup();
  const a = held("a");
  const b = held("b");
  const codex = held("c", "rate_limit", "codex");
  const overload = held("d", "overloaded");
  const jitters: number[] = [];
  const woken = waits.limitCleared("claude", "a", () => (jitters.push(0), 0));
  expect(woken).toEqual(["b"]);
  expect(jitters).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 5));
  expect(b.sent).toEqual(["b"]);
  expect(a.sent).toEqual([]); // the caller's own hold is not woken by itself
  expect(codex.sent).toEqual([]); // another account
  expect(overload.sent).toEqual([]); // not a limit: its backoff stays
});

test("a resend that throws never breaks the registry", () => {
  const { waits } = setup();
  const d = manualDelay();
  waits.hold({ orderId: "x", kind: "rate_limit", provider: "claude", until: NOW + 1 }, d.delay, () => { throw new Error("boom"); });
  expect(waits.wake("x", "retry")).toBe(true);
  expect(waits.held("x")).toBeUndefined();
});

test("apiWait shows any API backoff, marked limit or not; limitWait stays limits only", () => {
  const ledger = openLedger(":memory:");
  ledger.recordEvent("api_retry", { orderId: "o", at: NOW, data: { kind: "overloaded", delayMs: 60_000 } });
  expect(apiWait(ledger, "o", NOW)).toEqual({ resumesAt: NOW + 60_000, limit: false });
  expect(limitWait(ledger, "o", NOW)).toBeUndefined();
});
