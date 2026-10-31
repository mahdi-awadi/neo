// ADR-0072: order sizes — the size model, its config and the operator's override (spec §2, §10, AC 1–3).
import { test, expect } from "bun:test";
import {
  DEFAULT_SIZES_CFG,
  ORDER_SIZES,
  isOrderSize,
  larger,
  parseSizeOverride,
  readSizesCfg,
  resolveSize,
  type SizesCfg,
} from "../src/engine/order-size";

test("the sizes run quick < standard < big; larger and isOrderSize", () => {
  expect([...ORDER_SIZES]).toEqual(["quick", "standard", "big"]);
  expect(larger("quick", "standard")).toBe("standard");
  expect(larger("big", "quick")).toBe("big");
  expect(larger("standard", "standard")).toBe("standard");
  expect(isOrderSize("quick")).toBe(true);
  expect(isOrderSize("huge")).toBe(false);
  expect(isOrderSize(undefined)).toBe(false);
});

test("readSizesCfg: the spec §10 defaults", () => {
  const d = DEFAULT_SIZES_CFG;
  expect(readSizesCfg(undefined)).toEqual(d);
  expect(d.enabled).toBe(true);
  expect(d.default).toBe("big");
  expect(d.side).toEqual({ "read-only": "quick", ops: "quick", test: "quick", code: "standard" });
  expect(d.override).toEqual({ quick: ["/quick", "quick fix", "إصلاح سريع"], big: ["/full"] });
  expect(d.quick).toEqual({ maxFiles: 5, maxLines: 200, maxServices: 1, resultMaxLines: 3, noNewFiles: ["**/adr/**"] });
  expect(d.standard).toEqual({ maxFiles: 20, maxLines: 1000, maxServices: 3 });
  expect(d.guard.serviceMarkers).toEqual(["Dockerfile", "Containerfile"]);
  expect(d.guard.rules.map((r) => [r.name, r.to])).toEqual([
    ["migration", "big"], ["auth", "big"], ["auth", "big"], ["money", "big"], ["secrets", "big"], ["deploy", "big"],
    ["prod", "big"], ["module", "big"], ["proto", "standard"], ["deps", "standard"],
  ]);
  expect(d.guard.rules.find((r) => r.name === "module")?.created).toBe(true);
  // The second auth rule is the auth-token words, with design and parser tokens exempt (review, ADR-0072).
  expect(d.guard.rules.filter((r) => r.name === "auth")[1]?.words).toEqual(["tokens?"]);
  expect(d.guard.rules.filter((r) => r.always).map((r) => r.name)).toEqual(["secrets", "deploy"]);
  expect(d.guard.ignore).toContain("docs/**");
  expect(d.guard.ignore).toContain("**/*.pb.go");
  expect(d.guard.ignore).toHaveLength(20);
  expect(d.attention).toEqual({});
  expect(d.projects).toEqual({});
  // Every default regex compiles case-insensitively.
  for (const r of d.guard.rules) for (const p of [...(r.names ?? []), ...(r.words ?? []), ...(r.commands ?? [])]) expect(() => new RegExp(p, "i")).not.toThrow();
});

test("readSizesCfg: well-typed values are kept", () => {
  const c = readSizesCfg({
    enabled: false,
    default: "standard",
    side: { code: "quick" },
    override: { quick: ["/fast"], big: ["/full", "full flow"] },
    quick: { maxFiles: 3, resultMaxLines: 5 },
    standard: { maxServices: 2 },
    guard: { rules: [{ name: "billing", to: "big", words: ["billing"] }], serviceMarkers: ["go.mod"], ignore: ["vendor/**"] },
    attention: { dirty: "standard" },
    projects: { "eticket-v3": { rules: [{ name: "charter", to: "big", paths: ["**/charter/**"] }], except: ["tools/**"] } },
  });
  expect(c.enabled).toBe(false);
  expect(c.default).toBe("standard");
  expect(c.side).toEqual({ "read-only": "quick", ops: "quick", test: "quick", code: "quick" });
  expect(c.override).toEqual({ quick: ["/fast"], big: ["/full", "full flow"] });
  expect(c.quick).toEqual({ ...DEFAULT_SIZES_CFG.quick, maxFiles: 3, resultMaxLines: 5 });
  expect(c.standard).toEqual({ ...DEFAULT_SIZES_CFG.standard, maxServices: 2 });
  expect(c.guard).toEqual({ rules: [{ name: "billing", to: "big", words: ["billing"] }], serviceMarkers: ["go.mod"], ignore: ["vendor/**"] });
  expect(c.attention).toEqual({ dirty: "standard" });
  expect(c.projects["eticket-v3"]).toEqual({ rules: [{ name: "charter", to: "big", paths: ["**/charter/**"] }], except: ["tools/**"] });
});

test("readSizesCfg: a bad field keeps its default", () => {
  const d = DEFAULT_SIZES_CFG;
  // A size that is not one.
  expect(readSizesCfg({ default: "huge" }).default).toBe("big");
  expect(readSizesCfg({ side: { ops: "tiny" } }).side).toEqual(d.side);
  // A limit of 0, a float, a negative, a string.
  expect(readSizesCfg({ quick: { maxFiles: 0, maxLines: 2.5, maxServices: -1, resultMaxLines: "3" } }).quick).toEqual(d.quick);
  expect(readSizesCfg({ standard: { maxFiles: 0, maxLines: 10.5 } }).standard).toEqual(d.standard);
  // A non-array override list, or one with an empty phrase.
  expect(readSizesCfg({ override: { quick: "/quick", big: ["", "/full"] } }).override).toEqual(d.override);
  // A rule list with one bad regex keeps the whole default list.
  expect(readSizesCfg({ guard: { rules: [{ name: "ok", to: "big", words: ["fine"] }, { name: "bad", to: "big", words: ["(unclosed"] }] } }).guard.rules).toEqual(d.guard.rules);
  expect(readSizesCfg({ guard: { rules: [{ name: "ok", to: "huge", words: ["x"] }] } }).guard.rules).toEqual(d.guard.rules);
  expect(readSizesCfg({ guard: { rules: [{ to: "big", words: ["x"] }] } }).guard.rules).toEqual(d.guard.rules);
  expect(readSizesCfg({ guard: { rules: "all" } }).guard.rules).toEqual(d.guard.rules);
  expect(readSizesCfg({ enabled: "yes" }).enabled).toBe(true);
  // An attention size that is not one is dropped; a project with a bad rule list gets none.
  expect(readSizesCfg({ attention: { dirty: "huge", ci_failed: "big" } }).attention).toEqual({ ci_failed: "big" });
  expect(readSizesCfg({ projects: { p: { rules: [{ name: "x", to: "big", names: ["["] }], except: [3] } } }).projects).toEqual({ p: { rules: [], except: [] } });
});

test("parseSizeOverride: only at the start of the operator's message", () => {
  const c = DEFAULT_SIZES_CFG;
  expect(parseSizeOverride("/quick fix the picker", c)).toEqual({ size: "quick", rest: "fix the picker" });
  expect(parseSizeOverride("/quick@neo_bot x", c)).toEqual({ size: "quick", rest: "x" });
  expect(parseSizeOverride("/full x", c)).toEqual({ size: "big", rest: "x" });
  expect(parseSizeOverride("Quick fix: x", c)).toEqual({ size: "quick", rest: "x" });
  expect(parseSizeOverride("quick fix — x", c)).toEqual({ size: "quick", rest: "x" });
  expect(parseSizeOverride("إصلاح سريع: x", c)).toEqual({ size: "quick", rest: "x" });
  expect(parseSizeOverride("this is not a quick fix", c)).toBeUndefined();
  expect(parseSizeOverride("/quickly x", c)).toBeUndefined();
  expect(parseSizeOverride("quick fixes for the list", c)).toBeUndefined();
  expect(parseSizeOverride("/quick", c)).toEqual({ size: "quick", rest: "" });
  expect(parseSizeOverride("", c)).toBeUndefined();
});

test("parseSizeOverride: the phrases come from config", () => {
  const c: SizesCfg = { ...DEFAULT_SIZES_CFG, override: { quick: ["/fast"], big: ["full flow"] } };
  expect(parseSizeOverride("/quick x", c)).toBeUndefined();
  expect(parseSizeOverride("/fast x", c)).toEqual({ size: "quick", rest: "x" });
  expect(parseSizeOverride("Full flow, x", c)).toEqual({ size: "big", rest: "x" });
});

test("resolveSize: the precedence of spec §2, with by and why", () => {
  const c = DEFAULT_SIZES_CFG;
  const r = (i: Parameters<typeof resolveSize>[0]) => resolveSize(i, c);
  // forced > override
  expect(r({ forced: "codex", override: "quick" })).toMatchObject({ size: "big", by: "engine" });
  expect(r({ forced: "codex" }).why).toContain("Codex");
  expect(r({ forced: "customer", chosen: "quick" }).why).toContain("customer");
  expect(r({ forced: "team", chosen: "quick" }).why).toContain("team");
  // override > chosen
  expect(r({ override: "quick", chosen: "big" })).toMatchObject({ size: "quick", by: "operator" });
  expect(r({ override: "big", chosen: "quick" })).toMatchObject({ size: "big", by: "operator" });
  // chosen > engine
  expect(r({ chosen: "standard", engine: "big" })).toMatchObject({ size: "standard", by: "company" });
  // engine > side
  expect(r({ engine: "big", side: "ops" })).toMatchObject({ size: "big", by: "engine" });
  // side > default
  expect(r({ side: "ops" })).toMatchObject({ size: "quick", by: "engine" });
  expect(r({ side: "code" })).toMatchObject({ size: "standard", by: "engine" });
  // default
  expect(r({})).toMatchObject({ size: "big", by: "engine" });
  expect(r({}).why).toContain("no size");
  for (const i of [{ forced: "codex" as const }, { override: "quick" as const }, { chosen: "quick" as const }, { engine: "quick" as const }, { side: "ops" as const }, {}])
    expect(typeof r(i).why).toBe("string");
});

test("resolveSize: sizes off → big for every input", () => {
  const off = { ...DEFAULT_SIZES_CFG, enabled: false };
  for (const i of [{}, { override: "quick" as const }, { chosen: "quick" as const }, { side: "ops" as const }, { engine: "standard" as const }])
    expect(resolveSize(i, off)).toMatchObject({ size: "big", by: "engine", why: "sizes are off" });
  // The configured default applies when nothing else does.
  expect(resolveSize({}, { ...DEFAULT_SIZES_CFG, default: "standard" }).size).toBe("standard");
});
