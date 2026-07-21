import { test, expect } from "bun:test";
import { createOperatorBus, type BusLine, type OperatorSink } from "../src/engine/operator-bus";

/** A recording sink — captures every line delivered to it. */
function recorder(id: string): OperatorSink & { lines: BusLine[] } {
  const lines: BusLine[] = [];
  return { id, lines, deliver: (l) => lines.push(l) };
}

test("mirror fans a line out to every sink EXCEPT the origin", () => {
  const bus = createOperatorBus();
  const tg = recorder("telegram");
  const web = recorder("web");
  bus.register(tg);
  bus.register(web);

  bus.mirror("telegram", { kind: "reply", text: "hello", project: "eticket" });

  expect(tg.lines).toEqual([]); // origin excluded — it already displayed this locally
  expect(web.lines).toEqual([{ kind: "reply", text: "hello", project: "eticket" }]);
});

test("mirror with only the origin registered delivers to nobody and does not throw", () => {
  const bus = createOperatorBus();
  const tg = recorder("telegram");
  bus.register(tg);

  expect(() => bus.mirror("telegram", { kind: "echo", text: "solo" })).not.toThrow();
  expect(tg.lines).toEqual([]);
});

test("a throwing sink never blocks the other sinks (resilience)", () => {
  const bus = createOperatorBus();
  const boom: OperatorSink = { id: "web", deliver: () => { throw new Error("no listener"); } };
  const tg = recorder("telegram");
  bus.register(boom);
  bus.register(tg);

  expect(() => bus.mirror("web", { kind: "reply", text: "still delivered" })).not.toThrow();
  expect(tg.lines).toEqual([{ kind: "reply", text: "still delivered" }]);
});

test("unregister removes a sink from future fan-out", () => {
  const bus = createOperatorBus();
  const tg = recorder("telegram");
  const web = recorder("web");
  bus.register(tg);
  const off = bus.register(web);

  off();
  bus.mirror("telegram", { kind: "notice", text: "gone?" });

  expect(web.lines).toEqual([]); // unregistered — no longer receives
});

test("registering the same id twice replaces the prior sink (one surface, one sink)", () => {
  const bus = createOperatorBus();
  const first = recorder("web");
  const second = recorder("web");
  bus.register(first);
  bus.register(second);

  bus.mirror("telegram", { kind: "reply", text: "hi" });

  expect(first.lines).toEqual([]); // replaced
  expect(second.lines).toEqual([{ kind: "reply", text: "hi" }]);
});
