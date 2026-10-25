// Tool cards (ADR-0044, spec §2 + A2): parse + validate. One `<file>: <field>` error per broken rule.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSecret } from "../src/engine/secret-patterns";
import { DEFAULT_TOOLS_CFG, loadCards, parseCard, readToolsCfg, relayKeyNames } from "../src/engine/tools-catalogue";

const cfg = DEFAULT_TOOLS_CFG;
const BODY = "## How to call\nrun it\n\n## When NOT to use\nnever\n";

function card(over: Record<string, unknown> = {}, body = BODY): string {
  const base: Record<string, unknown> = {
    id: "demo", kind: "cli", status: "active", owner: "neo", when: "Use when a demo is needed.",
    scope: "all", env: [], cost: "free", limits: "none", dataLeavesHost: false,
    tags: ["demo"], examples: ["run a demo"],
  };
  const merged = { ...base, ...over };
  const fm = Object.entries(merged).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  return `---\n${fm}\n---\n${body}`;
}

const errs = (text: string, file = "demo.md") => parseCard(file, text, cfg).errors;

test("a good card parses with no errors", () => {
  const r = parseCard("demo.md", card(), cfg);
  expect(r.errors).toEqual([]);
  expect(r.card?.id).toBe("demo");
  expect(r.card?.scope).toBe("all");
});

test("no front matter is an error, not a crash", () => {
  expect(errs("# just text")).toEqual(["demo.md: front matter is missing"]);
  expect(errs("---\n: : [\n---\nx")[0]).toStartWith("demo.md: front matter");
});

test("missing field, bad enum, id not matching the file", () => {
  expect(errs(card({ owner: undefined }))).toContain("demo.md: owner is required");
  expect(errs(card({ kind: "weird" }))).toContain("demo.md: kind must be one of mcp, cli, api, recipe");
  expect(errs(card({ status: "x" }))).toContain("demo.md: status must be one of active, candidate, retired");
  expect(errs(card({ id: "other" }))).toContain("demo.md: id must match the file name");
});

test("when is capped by tools.whenMaxChars", () => {
  expect(errs(card({ when: "x".repeat(301) }))).toContain("demo.md: when is longer than 300 chars");
});

test("an active card needs tags and examples; tags are capped", () => {
  expect(errs(card({ tags: undefined }))).toContain("demo.md: tags is required on an active card");
  expect(errs(card({ examples: [] }))).toContain("demo.md: examples is required on an active card");
  expect(errs(card({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }))).toContain("demo.md: tags has more than 12 entries");
  expect(errs(card({ examples: Array.from({ length: 7 }, (_, i) => `e${i}`) }))).toContain("demo.md: examples has more than 6 entries");
  expect(errs(card({ tags: ["Bad Tag"] }))).toContain("demo.md: tags entry 1 must be a lowercase word");
  expect(errs(card({ status: "candidate", tags: undefined, examples: undefined }))).toEqual([]);
});

test("env holds key names only, and a value never appears in the error", () => {
  const secret = ["sk-ant", "SENTINEL".repeat(4)].join("-");
  const e = errs(card({ env: ["GOOD_KEY", secret, "lower case value"] }));
  expect(e).toContain("demo.md: env entry 2 is not a key name");
  expect(e).toContain("demo.md: env entry 3 is not a key name");
  expect(e.join("\n")).not.toContain("SENTINEL");
  expect(e.join("\n")).not.toContain("case value");
});

test("relay only on api cards; an active api card must have one", () => {
  const relay = { baseUrl: "https://api.example.com", authHeader: "x-api-key", envKey: "EX_KEY", maxBodyBytes: 100, operations: [{ name: "go", method: "POST", path: "/go" }] };
  expect(errs(card({ relay }))).toContain("demo.md: relay is only allowed on api cards");
  expect(errs(card({ kind: "api" }))).toContain("demo.md: relay is required on an active api card");
  expect(errs(card({ kind: "api", relay, env: ["EX_KEY"] }))).toEqual([]);
  expect(errs(card({ kind: "api", relay, env: [] }))).toContain("demo.md: relay.envKey must also be listed in env");
  expect(errs(card({ kind: "api", env: ["EX_KEY"], relay: { ...relay, baseUrl: "http://x.com" } }))).toContain("demo.md: relay.baseUrl must be https");
  expect(errs(card({ kind: "api", env: ["EX_KEY"], relay: { ...relay, operations: [{ name: "a", method: "DELETE", path: "/x" }, { name: "b", method: "GET", path: "x" }] } })))
    .toEqual(["demo.md: relay.operations entry 1 method must be GET or POST", "demo.md: relay.operations entry 2 path must start with /"]);
  expect(errs(card({ kind: "api", status: "candidate", tags: undefined, examples: undefined }))).toEqual([]);
});

test("the body needs both sections", () => {
  const e = errs(card({}, "nothing here"));
  expect(e).toContain("demo.md: body needs a '## How to call' section");
  expect(e).toContain("demo.md: body needs a '## When NOT to use' section");
});

test("recipe: steps 2-10, no relay", () => {
  const rec = { kind: "recipe", steps: [{ card: "a", do: "x" }] };
  expect(errs(card(rec))).toContain("demo.md: steps needs 2 to 10 entries");
  expect(errs(card({ ...rec, relay: { baseUrl: "https://a.b" } }))).toContain("demo.md: relay is only allowed on api cards");
  expect(errs(card({ kind: "cli", steps: [{ card: "a", do: "x" }, { card: "b", do: "y" }] }))).toContain("demo.md: steps is only allowed on recipe cards");
});

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "neo-tools-"));
  for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
  return d;
}

test("loadCards: recipe steps must name active non-recipe cards", () => {
  const steps = (cards: string[]) => cards.map((c) => ({ card: c, do: "do it" }));
  const d = dir({
    "aaa.md": card({ id: "aaa" }),
    "bbb.md": card({ id: "bbb", status: "candidate", tags: undefined, examples: undefined }),
    "rec1.md": card({ id: "rec1", kind: "recipe", steps: steps(["aaa", "bbb"]) }),
    "rec2.md": card({ id: "rec2", kind: "recipe", steps: steps(["aaa", "rec3"]) }),
    "rec3.md": card({ id: "rec3", kind: "recipe", steps: steps(["aaa", "missing"]) }),
    "fine.md": card({ id: "fine", kind: "recipe", steps: steps(["aaa", "aaa"]) }),
  });
  const { cards, errors } = loadCards(d, cfg);
  expect(errors).toContain("rec1.md: steps entry 2 names a card that is not active (bbb)");
  expect(errors).toContain("rec2.md: steps entry 2 names a recipe (rec3)");
  expect(errors).toContain("rec3.md: steps entry 2 names a card that does not exist (missing)");
  expect(errors.length).toBe(3);
  expect(cards.map((c) => c.id)).toContain("fine");
});

test("loadCards: duplicate ids, non-markdown files and a missing dir", () => {
  const d = dir({ "aaa.md": card({ id: "aaa" }), "notes.txt": "ignored" });
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "bbb.md"), card({ id: "bbb" }).replace("id: \"bbb\"", "id: \"aaa\""));
  const { errors } = loadCards(d, cfg);
  expect(errors).toContain("bbb.md: id must match the file name");
  expect(errors).toContain("bbb.md: id aaa is already used by aaa.md");
  expect(loadCards(join(d, "nope"), cfg).errors).toEqual([`${join(d, "nope")}: catalogue folder cannot be read`]);
});

test("readToolsCfg falls back to the defaults on bad types", () => {
  expect(readToolsCfg(undefined)).toEqual(DEFAULT_TOOLS_CFG);
  expect(readToolsCfg("x")).toEqual(DEFAULT_TOOLS_CFG);
  const bad = readToolsCfg({ relayEnabled: "yes", timeoutMs: -1, maxReplyChars: "9", catalogueDir: "", hintPaths: [1], stopWords: "a", minScore: NaN, showDisallowed: 1 });
  expect(bad).toEqual(DEFAULT_TOOLS_CFG);
  const good = readToolsCfg({ relayEnabled: true, timeoutMs: 5000, catalogueDir: "x/y", hintPaths: ["dispatch", "project"], usageWeight: 0, stopWords: ["foo"] });
  expect(good.relayEnabled).toBe(true);
  expect(good.timeoutMs).toBe(5000);
  expect(good.catalogueDir).toBe("x/y");
  expect(good.hintPaths).toEqual(["dispatch", "project"]);
  expect(good.usageWeight).toBe(0);
  expect(good.stopWords).toEqual(["foo"]);
  expect(good.maxCallsPerProjectPerDay).toBe(200);
});

test("defaults match the spec", () => {
  expect(DEFAULT_TOOLS_CFG).toMatchObject({
    relayEnabled: false, maxCallsPerProjectPerDay: 200, timeoutMs: 20000, maxReplyChars: 20000, whenMaxChars: 300,
    catalogueDir: "docs/tools", queryMaxTerms: 24, minScore: 0.5, usageWeight: 0.3, usageCacheMs: 600000,
    showDisallowed: false, findLimit: 5, replyMaxChars: 4000, howMaxChars: 400, hintMaxCards: 3, hintMaxChars: 500,
    hintPaths: ["dispatch"], skillifyMin: 3,
  });
});

// The real catalogue: a bad card in docs/tools fails `bun test` (spec §7 AC1).
const REAL = join(import.meta.dir, "..", "docs", "tools");

test("the real docs/tools loads with zero errors", () => {
  const { cards, errors } = loadCards(REAL, DEFAULT_TOOLS_CFG);
  expect(errors).toEqual([]);
  const active = cards.filter((c) => c.status === "active").map((c) => c.id).sort();
  expect(active).toEqual([
    "chrome-devtools", "codebase-memory", "create-loop", "disk-kit", "eticket-data-mcp", "playwright",
    "project-notes", "security-kit", "shared-browser", "stitch",
  ]);
});

test("scaledown is a candidate api card that sends data off the host; no card holds a key value", () => {
  const { cards } = loadCards(REAL, DEFAULT_TOOLS_CFG);
  const sd = cards.find((c) => c.id === "scaledown")!;
  expect(sd.status).toBe("candidate");
  expect(sd.kind).toBe("api");
  expect(sd.dataLeavesHost).toBe(true);
  expect(sd.relay).toEqual({
    baseUrl: "https://api.scaledown.xyz", authHeader: "x-api-key", envKey: "SCALEDOWN_API_KEY", maxBodyBytes: 262144,
    operations: [{ name: "compress", method: "POST", path: "/compress/raw/" }],
  });
  for (const c of cards) expect(findSecret(c.body)).toBeUndefined();
});

test("eticket-data-mcp is scoped to eticket-v3; active cards carry usage globs", () => {
  const { cards } = loadCards(REAL, DEFAULT_TOOLS_CFG);
  expect(cards.find((c) => c.id === "eticket-data-mcp")!.scope).toEqual(["eticket-v3"]);
  for (const c of cards.filter((x) => x.status === "active")) expect(c.usage?.tools?.length || c.usage?.commands?.length).toBeTruthy();
});

// Final review, Important #3 (T5): every card file that names a relay key keeps it in the engine — a
// card that fails to parse or to validate too, so a broken card never leaks its key to a worker.
test("final review: relayKeyNames reads relay.envKey from valid AND invalid cards, never a plain env list", () => {
  const relay = (envKey: string) => ({ baseUrl: "https://api.example.com", authHeader: "x-api-key", envKey, maxBodyBytes: 100, operations: [{ name: "ping", method: "GET", path: "/p" }] });
  const d = dir({
    "good.md": card({ id: "good", kind: "api", env: ["GOOD_KEY"], relay: relay("GOOD_KEY") }),
    // Valid YAML, invalid card (no owner, unknown status): the key is still collected.
    "half.md": card({ id: "half", kind: "api", owner: undefined, status: "bogus", env: ["HALF_KEY"], relay: relay("HALF_KEY") }),
    // Broken YAML: a best-effort line scan still finds the key.
    "broken.md": "---\nid: broken\nkind: api\nwhen: [unclosed\nrelay:\n  envKey: BROKEN_KEY\n---\nbody\n",
    // No relay: its env keys are the worker's own (an MCP may need them) — never collected.
    "plain.md": card({ id: "plain", env: ["PLAIN_KEY"] }),
    // Not a key name: ignored.
    "odd.md": "---\nrelay:\n  envKey: not a key\n---\n",
  });
  const loaded = loadCards(d, cfg);
  expect(loaded.cards.map((c) => c.id)).not.toContain("half");
  expect(loaded.cards.map((c) => c.id)).not.toContain("broken");
  expect(relayKeyNames(d).sort()).toEqual(["BROKEN_KEY", "GOOD_KEY", "HALF_KEY"]);
  expect(relayKeyNames(join(d, "missing"))).toEqual([]);
});
