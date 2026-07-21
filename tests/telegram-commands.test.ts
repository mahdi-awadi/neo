import { test, expect } from "bun:test";
import { toTelegramCommands, telegramCommands } from "../src/engine/commands";

// Pure derivation: command metadata -> Telegram setMyCommands shape. The frontend just registers
// the result, so all the shaping rules (slash strip, name validation, description limit) live here.

test("maps name -> command (slash stripped, lowercased) and summary -> description", () => {
  const out = toTelegramCommands([{ name: "/List", summary: "open projects" }]);
  expect(out).toEqual([{ command: "list", description: "open projects" }]);
});

test("keeps commands that take args — Telegram shows the base command", () => {
  const out = toTelegramCommands([
    { name: "use", summary: "address a project" },
    { name: "pin", summary: "pin a project" },
    { name: "kill", summary: "stop a project" },
  ]);
  expect(out.map((c) => c.command)).toEqual(["use", "pin", "kill"]);
});

test("drops names that violate Telegram's ^[a-z0-9_]{1,32}$ constraint", () => {
  const out = toTelegramCommands([
    { name: "ok_cmd", summary: "fine" },
    { name: "bad-dash", summary: "hyphen not allowed" },
    { name: "has space", summary: "space not allowed" },
    { name: "café", summary: "non-ascii" },
    { name: "", summary: "empty" },
    { name: "x".repeat(33), summary: "too long" },
  ]);
  expect(out.map((c) => c.command)).toEqual(["ok_cmd"]);
});

test("truncates descriptions to Telegram's 256-char limit", () => {
  const out = toTelegramCommands([{ name: "list", summary: "x".repeat(300) }]);
  expect(out[0]!.description.length).toBe(256);
  expect(out[0]!.description).toBe("x".repeat(256));
});

test("telegramCommands() derives the live COMMANDS registry into valid Telegram commands", () => {
  const out = telegramCommands();
  expect(out.length).toBeGreaterThan(0);
  for (const c of out) {
    expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(c.description.length).toBeGreaterThan(0);
    expect(c.description.length).toBeLessThanOrEqual(256);
  }
  const names = out.map((c) => c.command);
  // Real operator commands are present…
  expect(names).toContain("list");
  expect(names).toContain("help");
  expect(names).toContain("use");
  // …but aliases (e.g. `ls` for list) are NOT emitted as separate entries — we derive from name only.
  expect(names).not.toContain("ls");
  // no duplicates
  expect(new Set(names).size).toBe(names.length);
});
