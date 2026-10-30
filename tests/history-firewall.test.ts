// ADR-0067 firewall (spec "Sources", AC12): the verdict for a source row fails closed — the customer path
// (a CUSTOMER_CHAT order and all its descendants, ingress threads, customer-chat messages), a missing
// order or parent, an over-deep lineage, a missing thread and an unclassifiable row are excluded and
// counted. The history code never imports the inbox module (checked over the whole import graph).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openLedger, type Ledger } from "../src/engine/ledger";
import { CUSTOMER_CHAT, SIDE_CHAT, SUB_CHAT } from "../src/engine/chats";
import { anchoredVerdict, countRule, orderVerdict, type FirewallLookups } from "../src/engine/history/firewall";
import type { Order } from "../src/types";

const order = (over: Partial<Order> = {}): Order => ({ id: "o1", source: "neo", folder: "/p", task: "t", chatId: SUB_CHAT, createdAt: 1000, ...over });

/** Lookups over a real ledger, the way the indexer builds them. */
function lookups(led: Ledger, depth = 8): FirewallLookups {
  return {
    lineage: (id) => led.historyLineage([id], { maxDepth: depth }).get(id),
    threadOrigin: (id) => led.threadById(id)?.origin,
  };
}

function thread(led: Ledger, origin: "operator" | "ingress"): number {
  const t = led.insertMessage({ chatId: 1, role: "user", content: origin, at: 1 });
  led.insertThread({ id: t, origin, title: origin, state: "open", createdAt: 1 });
  return t;
}

describe("orders", () => {
  test("a dispatch order on an operator thread, its child and a side-lane order pass", () => {
    const led = openLedger(":memory:");
    const t = thread(led, "operator");
    led.recordOrder(order({ id: "a", chatId: 1 }), { cause: { msgId: t, threadId: t } });
    led.recordOrder(order({ id: "b" }), { parentOrderId: "a" });
    led.recordOrder(order({ id: "s", chatId: SIDE_CHAT }));
    const look = lookups(led);
    for (const id of ["a", "b", "s"]) expect(orderVerdict(look.lineage(id))).toEqual({ verdict: "ok" });
  });

  test("a CUSTOMER_CHAT order, its child and its grandchild are excluded", () => {
    const led = openLedger(":memory:");
    led.recordOrder(order({ id: "c", chatId: CUSTOMER_CHAT }));
    led.recordOrder(order({ id: "k" }), { parentOrderId: "c" });
    led.recordOrder(order({ id: "g" }), { parentOrderId: "k" });
    const look = lookups(led);
    expect(orderVerdict(look.lineage("c"))).toEqual({ verdict: "excluded", rule: "customer_chat" });
    expect(orderVerdict(look.lineage("k"))).toEqual({ verdict: "excluded", rule: "ancestor_excluded" });
    expect(orderVerdict(look.lineage("g"))).toEqual({ verdict: "excluded", rule: "ancestor_excluded" });
  });

  test("an order on an ingress thread, and the child of one, are excluded", () => {
    const led = openLedger(":memory:");
    const t = thread(led, "ingress");
    led.recordOrder(order({ id: "i" }), { cause: { msgId: t, threadId: t } });
    led.recordOrder(order({ id: "j" }), { parentOrderId: "i" });
    const look = lookups(led);
    expect(orderVerdict(look.lineage("i"))).toEqual({ verdict: "excluded", rule: "ingress_thread" });
    expect(orderVerdict(look.lineage("j"))).toEqual({ verdict: "excluded", rule: "ancestor_excluded" });
  });

  test("an order whose source is not neo is excluded", () => {
    const led = openLedger(":memory:");
    led.recordOrder(order({ id: "x", source: "customer" as Order["source"] }));
    const look = lookups(led);
    expect(orderVerdict(look.lineage("x"))).toEqual({ verdict: "excluded", rule: "not_neo_source" });
  });

  test("a missing parent, a missing order, a chain deeper than 8 and a cycle are excluded", () => {
    const led = openLedger(":memory:");
    led.recordOrder(order({ id: "orphan" }), { parentOrderId: "gone" });
    led.recordOrder(order({ id: "n0" }));
    for (let i = 1; i <= 10; i++) led.recordOrder(order({ id: `n${i}` }), { parentOrderId: `n${i - 1}` });
    led.recordOrder(order({ id: "x" }), { parentOrderId: "y" });
    led.recordOrder(order({ id: "y" }), { parentOrderId: "x" });
    const look = lookups(led);
    expect(orderVerdict(look.lineage("orphan"))).toEqual({ verdict: "excluded", rule: "missing_parent" });
    expect(orderVerdict(look.lineage("unknown"))).toEqual({ verdict: "excluded", rule: "missing_order" });
    expect(orderVerdict(undefined)).toEqual({ verdict: "excluded", rule: "missing_order" });
    expect(orderVerdict(look.lineage("n10"))).toEqual({ verdict: "excluded", rule: "too_deep" });
    expect(orderVerdict(look.lineage("n8"))).toEqual({ verdict: "ok" });
    expect(orderVerdict(look.lineage("x"))).toEqual({ verdict: "excluded", rule: "too_deep" });
  });

  test("an order whose thread row is missing is excluded (its origin cannot be checked)", () => {
    const led = openLedger(":memory:");
    led.recordOrder(order({ id: "m" }), { cause: { msgId: 999, threadId: 999 } });
    const look = lookups(led);
    expect(orderVerdict(look.lineage("m"))).toEqual({ verdict: "excluded", rule: "missing_thread" });
  });

  test("a customer root deeper up than an excluded check still wins over a later miss", () => {
    const led = openLedger(":memory:");
    led.recordOrder(order({ id: "c", chatId: CUSTOMER_CHAT }), { parentOrderId: "gone" });
    led.recordOrder(order({ id: "k" }), { parentOrderId: "c" });
    const look = lookups(led);
    expect(orderVerdict(look.lineage("k"))).toMatchObject({ verdict: "excluded" });
  });
});

describe("rows anchored to an order, a thread or a chat", () => {
  test("a row follows its order", () => {
    const led = openLedger(":memory:");
    led.recordOrder(order({ id: "c", chatId: CUSTOMER_CHAT }));
    led.recordOrder(order({ id: "ok" }));
    const look = lookups(led);
    expect(anchoredVerdict({ orderId: "ok" }, look, "unclassified")).toEqual({ verdict: "ok" });
    expect(anchoredVerdict({ orderId: "c" }, look, "unclassified")).toEqual({ verdict: "excluded", rule: "customer_chat" });
    expect(anchoredVerdict({ orderId: "gone" }, look, "unclassified")).toEqual({ verdict: "excluded", rule: "missing_order" });
  });

  test("a row on an ingress thread is excluded even when its order passes", () => {
    const led = openLedger(":memory:");
    const ti = thread(led, "ingress");
    const to = thread(led, "operator");
    led.recordOrder(order({ id: "ok" }));
    const look = lookups(led);
    expect(anchoredVerdict({ orderId: "ok", threadId: ti }, look, "unclassified")).toEqual({ verdict: "excluded", rule: "ingress_thread" });
    expect(anchoredVerdict({ threadId: to }, look, "unclassified")).toEqual({ verdict: "ok" });
    expect(anchoredVerdict({ threadId: 4242 }, look, "unclassified")).toEqual({ verdict: "excluded", rule: "missing_thread" });
  });

  test("a row on CUSTOMER_CHAT is excluded", () => {
    const look = lookups(openLedger(":memory:"));
    expect(anchoredVerdict({ chatId: CUSTOMER_CHAT }, look, "ok")).toEqual({ verdict: "excluded", rule: "customer_chat" });
    expect(anchoredVerdict({ chatId: 1 }, look, "ok")).toEqual({ verdict: "ok" });
  });

  test("a row with no order and no thread takes the given fallback", () => {
    const look = lookups(openLedger(":memory:"));
    expect(anchoredVerdict({}, look, "wait")).toEqual({ verdict: "wait" });
    expect(anchoredVerdict({}, look, "unclassified")).toEqual({ verdict: "excluded", rule: "unclassified" });
    expect(anchoredVerdict({ chatId: 1 }, look, "unclassified")).toEqual({ verdict: "excluded", rule: "unclassified" });
  });

  test("countRule tallies each rule", () => {
    const counts = {};
    countRule(counts, "customer_chat");
    countRule(counts, "customer_chat");
    countRule(counts, "unknown_table");
    expect(counts).toEqual({ customer_chat: 2, unknown_table: 1 });
  });
});

describe("static: the history code never reaches the inbox module", () => {
  const root = resolve(import.meta.dir, "..");
  const historyDir = join(root, "src/engine/history");

  /** Relative imports of a TypeScript file (static, re-exports and dynamic). */
  function importsOf(file: string): string[] {
    const src = readFileSync(file, "utf8");
    const out: string[] = [];
    for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g)) {
      out.push((m[1] ?? m[2] ?? m[3])!);
    }
    return out;
  }
  const resolveTs = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined;
    const base = resolve(dirname(from), spec);
    return [base, `${base}.ts`, join(base, "index.ts")].find((p) => p.endsWith(".ts") && existsSync(p));
  };

  test("no file under src/engine/history/ names the inbox module", () => {
    for (const f of readdirSync(historyDir).filter((n) => n.endsWith(".ts"))) {
      for (const spec of importsOf(join(historyDir, f))) expect(spec).not.toMatch(/(^|\/)inbox(-[a-z]+)?(\.ts)?$/);
    }
  });

  test("no module the history code imports, directly or through others, is the inbox module", () => {
    const seen = new Set<string>();
    const stack = readdirSync(historyDir).filter((n) => n.endsWith(".ts")).map((n) => join(historyDir, n));
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const spec of importsOf(f)) {
        const t = resolveTs(f, spec);
        if (t) stack.push(t);
      }
    }
    expect(seen.size).toBeGreaterThan(5);
    const inbox = [...seen].filter((f) => /\/src\/engine\/inbox(-[a-z]+)?\.ts$/.test(f));
    expect(inbox).toEqual([]);
  });
});
