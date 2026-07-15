import { test, expect } from "bun:test";
import { registerDefaultProject, defaultOrder, DEFAULT_PROJECT } from "../src/engine/default-project";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";

test("defaultOrder targets the agent workspace on the reserved chat id", () => {
  const o = defaultOrder(7);
  expect(o.folder).toBe(DEFAULT_PROJECT.folder);
  expect(o.chatId).toBe(-1);
  expect(o.source).toBe("neo");
});

test("registerDefaultProject pins an idle, control-less default session", () => {
  const reg = createRegistry();
  const led = openLedger(":memory:");
  const s = registerDefaultProject(reg, led, undefined, () => 5);

  expect(reg.getDefault()?.id).toBe(s.id);
  expect(s.status).toBe("idle"); // ready + resumable, not a live worker
  expect(reg.getControl(s.id)).toBeUndefined(); // no SDK run started yet
  expect(reg.list().length).toBe(1); // pinned/listed from startup
});
