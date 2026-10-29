// The ledger usage source (ADR-0044 Phase 3, spec A5): ranking learns from what worked. A card's count is
// the number of `done` orders in the last 30 days that used it (its `usage` globs); relay p50 comes from
// `tool_api` events. Plain counts, no AI.
import { expect, test } from "bun:test";
import { openLedger, type Ledger } from "../src/engine/ledger";
import { activityLabel } from "../src/engine/session-runner";
import { DEFAULT_TOOLS_CFG, ledgerUsageSource, matchesGlob, openCatalogue, parseCard, type ToolCard } from "../src/engine/tools-catalogue";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const card = (id: string, usage: ToolCard["usage"], over: Partial<ToolCard> = {}): ToolCard => ({
  id, kind: "mcp", status: "active", owner: "neo", when: "w", scope: "all", env: [], cost: "c", limits: "l",
  dataLeavesHost: false, tags: ["t"], examples: ["e"], body: "", file: `${id}.md`, ...(usage ? { usage } : {}), ...over,
});

let seq = 0;
/** One order with its tool calls and (optionally) its outcome. */
function order(led: Ledger, status: string | undefined, calls: Array<[tool: string, label: string]>, at = NOW - DAY, verdict: "allow" | "auto" | "escalate" | "deny" = "allow"): string {
  const id = `o${++seq}`;
  led.recordOrder({ id, source: "neo", folder: "/p", task: "t", chatId: 1, createdAt: at });
  for (const [tool, label] of calls) led.recordToolAction({ orderId: id, folder: "/p", tool, label, verdict, at });
  if (status) led.recordOutcome(id, status, "s", at + 1);
  return id;
}

const cards = [
  card("playwright", { tools: ["mcp__playwright__*"] }),
  card("disk-kit", { commands: ["*tools/disk/*"] }),
  card("no-usage", undefined),
];

test("matchesGlob: * matches any run of characters, slashes and spaces included; the rest is literal", () => {
  expect(matchesGlob("*tools/disk/*", "Bash: bun /home/neo/tools/disk/cleanup.ts list")).toBe(true);
  expect(matchesGlob("mcp__playwright__*", "mcp__playwright__browser_click")).toBe(true);
  expect(matchesGlob("mcp__playwright__*", "x_mcp__playwright__a")).toBe(false);
  expect(matchesGlob("a.b", "aXb")).toBe(false);
  expect(matchesGlob("a?c", "abc")).toBe(true);
});

test("5 done orders beat 0; failed, denied and unfinished orders do not count", () => {
  const led = openLedger(":memory:");
  for (let i = 0; i < 5; i++) order(led, "done", [["mcp__playwright__browser_click", "browser_click"], ["mcp__playwright__browser_snapshot", "browser_snapshot"]]);
  order(led, "failed", [["Bash", "Bash: bun tools/disk/cleanup.ts list"]]);
  order(led, undefined, [["Bash", "Bash: bun tools/disk/cleanup.ts list"]]);
  order(led, "done", [["Bash", "Bash: bun tools/disk/cleanup.ts list"]], NOW - DAY, "deny");
  const u = ledgerUsageSource({ ledger: led, cards, cfg: DEFAULT_TOOLS_CFG, now: () => NOW });
  const m = u.okUses(["playwright", "disk-kit", "no-usage"]);
  expect(m.get("playwright")).toBe(5); // two calls in one order count once
  expect(m.get("disk-kit") ?? 0).toBe(0);
  expect(m.get("no-usage") ?? 0).toBe(0);
});

test("a commands glob matches a Bash label only; calls older than 30 days do not count", () => {
  const led = openLedger(":memory:");
  order(led, "done", [["Bash", "Bash: bun tools/disk/cleanup.ts list"]]);
  order(led, "done", [["Bash", "Bash: bun tools/disk/cleanup.ts list"]], NOW - 31 * DAY);
  order(led, "done", [["Read", "Read: /home/neo/tools/disk/README.md"]]);
  const u = ledgerUsageSource({ ledger: led, cards, cfg: DEFAULT_TOOLS_CFG, now: () => NOW });
  expect(u.okUses(["disk-kit"]).get("disk-kit")).toBe(1);
});

test("the counts are cached for usageCacheMs, then read again", () => {
  const led = openLedger(":memory:");
  let reads = 0;
  const counted: Pick<Ledger, "toolUsage" | "relayLatencies"> = {
    toolUsage: (o) => { reads++; return led.toolUsage(o); },
    relayLatencies: (o) => led.relayLatencies(o),
  };
  let now = NOW;
  const u = ledgerUsageSource({ ledger: counted, cards, cfg: { ...DEFAULT_TOOLS_CFG, usageCacheMs: 1000 }, now: () => now });
  u.okUses(["playwright"]);
  order(led, "done", [["mcp__playwright__browser_click", "browser_click"]]);
  expect(u.okUses(["playwright"]).get("playwright") ?? 0).toBe(0); // still the cached snapshot
  expect(reads).toBe(1);
  now += 1000;
  expect(u.okUses(["playwright"]).get("playwright")).toBe(1);
  expect(reads).toBe(2);
});

test("p50 is the median ms of the card's completed relay calls; refused and failed calls do not count", () => {
  const led = openLedger(":memory:");
  const ev = (data: Record<string, unknown>, at = NOW - DAY) => led.recordEvent("tool_api", { folder: "/p", at, data: { card: "demo-api", operation: "x", project: "p", ...data } });
  ev({ status: 200, ms: 300 });
  ev({ status: 200, ms: 100 });
  ev({ status: 500, ms: 200 });
  ev({ refused: "check 4" });
  ev({ status: 0, ms: 20_000, error: "timeout" });
  ev({ status: 200, ms: 9 }, NOW - 31 * DAY);
  const api = card("demo-api", undefined, { kind: "api" });
  const u = ledgerUsageSource({ ledger: led, cards: [api], cfg: DEFAULT_TOOLS_CFG, now: () => NOW });
  expect(u.p50("demo-api")).toBe(200);
  expect(u.p50("other")).toBeUndefined();
});

test("a ledger error gives no counts and no p50, never a throw", () => {
  const broken: Pick<Ledger, "toolUsage" | "relayLatencies"> = {
    toolUsage: () => { throw new Error("db"); },
    relayLatencies: () => { throw new Error("db"); },
  };
  const u = ledgerUsageSource({ ledger: broken, cards, cfg: DEFAULT_TOOLS_CFG, now: () => NOW });
  expect(u.okUses(["playwright"]).size).toBe(0);
  expect(u.p50("playwright")).toBeUndefined();
});

test("openCatalogue takes a usage factory: the ledger adapter gets the loaded cards and boosts a card that worked", () => {
  const led = openLedger(":memory:");
  const twins = ["twin-a", "twin-b"].map((id) => card(id, { tools: [`mcp__${id}__*`] }, { when: "Use to frobnicate widgets.", tags: ["frob"], examples: ["frobnicate"] }));
  for (let i = 0; i < 5; i++) order(led, "done", [["mcp__twin-b__go", "go"]]);
  order(led, "failed", [["mcp__twin-a__go", "go"]]);
  const cat = openCatalogue({ cards: twins, cfg: { ...DEFAULT_TOOLS_CFG, minScore: 0 }, ledger: led, usage: (cs) => ledgerUsageSource({ ledger: led, cards: cs, cfg: DEFAULT_TOOLS_CFG, now: () => NOW }) });
  expect(cat.find("frobnicate widgets", { project: "p", folder: "/p" }).map((m) => m.id)).toEqual(["twin-b", "twin-a"]);
});

test("a Skill call's label names the skill, so loading a generated skill counts for its card", () => {
  expect(activityLabel("Skill", { skill: "neo-recipe-deploy-check" })).toBe("Skill: neo-recipe-deploy-check");
  const led = openLedger(":memory:");
  const recipe = card("deploy-check", undefined, { kind: "recipe" });
  const tool = card("shared-browser", undefined, { kind: "cli" });
  order(led, "done", [["Skill", "Skill: neo-recipe-deploy-check"]]);
  order(led, "done", [["Skill", "Skill: neo-tool-shared-browser"], ["Skill", "Skill: neo-recipe-deploy-check"]]);
  order(led, "done", [["Bash", "Bash: echo Skill: neo-tool-shared-browser"]]); // not a Skill call
  const u = ledgerUsageSource({ ledger: led, cards: [recipe, tool], cfg: DEFAULT_TOOLS_CFG, now: () => NOW });
  const m = u.okUses(["deploy-check", "shared-browser"]);
  expect(m.get("deploy-check")).toBe(2);
  expect(m.get("shared-browser")).toBe(1);
});

test("review fix: matchesGlob has no catastrophic backtracking (10 stars on a 60-char label)", () => {
  const t0 = Date.now();
  expect(matchesGlob("*a*a*a*a*a*a*a*a*a*b", "a".repeat(60))).toBe(false);
  expect(matchesGlob("*a*b*c", "xxaxxbxxc")).toBe(true);
  expect(matchesGlob("**", "")).toBe(true);
  expect(Date.now() - t0).toBeLessThan(200);
});

test("review fix: a call the operator was asked about (escalate) does not count; only allow and auto do", () => {
  const led = openLedger(":memory:");
  order(led, "done", [["mcp__playwright__browser_click", "browser_click"]], NOW - DAY, "escalate");
  order(led, "done", [["mcp__playwright__browser_click", "browser_click"]], NOW - DAY, "auto");
  const u = ledgerUsageSource({ ledger: led, cards, cfg: DEFAULT_TOOLS_CFG, now: () => NOW });
  expect(u.okUses(["playwright"]).get("playwright")).toBe(1);
});

test("review fix: card usage globs are bounded and tools globs name MCP tools", () => {
  const card = (usage: string) => `---\nid: gl\nkind: cli\nstatus: candidate\nowner: neo\nwhen: w\nscope: all\nenv: []\ncost: c\nlimits: l\ndataLeavesHost: false\nusage:\n  ${usage}\n---\n## How to call\nx\n## When NOT to use\ny\n`;
  expect(parseCard("gl.md", card('commands: ["*a*b*c*d*"]'), DEFAULT_TOOLS_CFG).errors.join()).toContain("at most 3 *");
  expect(parseCard("gl.md", card(`commands: ["${"x".repeat(101)}"]`), DEFAULT_TOOLS_CFG).errors.join()).toContain("at most 100 chars");
  expect(parseCard("gl.md", card('tools: ["Read"]'), DEFAULT_TOOLS_CFG).errors.join()).toContain("start with mcp__");
  expect(parseCard("gl.md", card('tools: ["mcp__x__*"]'), DEFAULT_TOOLS_CFG).errors).toEqual([]);
});
