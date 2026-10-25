// Tool search (ADR-0044 Phase 2, spec A3): openCatalogue + find over cards and skills. Fake sources and
// temp dirs only — nothing reads the real ~/.claude.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { fsSkillSource } from "../src/engine/tool-skills";
import { DEFAULT_TOOLS_CFG, openCatalogue, type SkillSource, type ToolsCfg, type UsageSource } from "../src/engine/tools-catalogue";

const BODY = "## How to call\nrun the thing with the CLI\n\n## When NOT to use\nnever\n";

function cardText(over: Record<string, unknown>, body = BODY): string {
  const base: Record<string, unknown> = {
    kind: "cli", status: "active", owner: "neo", when: "Use when a demo is needed.",
    scope: "all", env: [], cost: "free", limits: "none", dataLeavesHost: false, tags: ["demo"], examples: ["run a demo"],
  };
  const fm = Object.entries({ ...base, ...over }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  return `---\n${fm}\n---\n${body}`;
}

function catalogueDir(cards: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-find-"));
  for (const c of cards) writeFileSync(join(dir, `${c.id}.md`), cardText(c));
  return dir;
}

const CARDS = [
  { id: "shared-browser", when: "Use when a test needs a real browser: screenshots and E2E checks.", tags: ["browser", "screenshot", "rtl", "e2e"], examples: ["take a screenshot of the RTL login page"] },
  { id: "codebase-memory", kind: "mcp", when: "Use to search code structure and call graphs.", tags: ["code", "graph", "search"], examples: ["find who calls this function"] },
  { id: "deploy-check", when: "Use to verify a deploy finished on Coolify.", tags: ["deploy", "coolify"], examples: ["check the prod deploy"] },
  { id: "eticket-data", kind: "mcp", when: "Use to query eticket booking data.", tags: ["eticket", "bookings", "sql"], examples: ["count bookings by status"], scope: ["eticket-v3"] },
  { id: "draft-card", status: "candidate", when: "Use for unicorn rendering.", tags: ["unicorn"], examples: ["render a unicorn"] },
  { id: "old-card", status: "retired", when: "Use for dragon rendering.", tags: ["dragon"], examples: ["render a dragon"] },
];

const noSkills: SkillSource = { global: () => [], project: () => [] };
const noUsage: UsageSource = { okUses: () => new Map(), p50: () => undefined };

function open(over: { cards?: Array<Record<string, unknown>>; cfg?: Partial<ToolsCfg>; skills?: SkillSource; usage?: UsageSource } = {}) {
  const ledger = openLedger(":memory:");
  const cat = openCatalogue({
    dir: catalogueDir(over.cards ?? CARDS), cfg: { ...DEFAULT_TOOLS_CFG, ...over.cfg }, skills: over.skills ?? noSkills, usage: over.usage ?? noUsage, ledger,
  });
  return { cat, ledger };
}
const ctx = { project: "waselni", folder: "/tmp/none-waselni" };

describe("find", () => {
  test("the screenshot query ranks shared-browser first and says why", () => {
    const { cat } = open();
    expect(cat.errors).toEqual([]);
    const r = cat.find("take a screenshot of the RTL page", ctx);
    expect(r[0]!.id).toBe("shared-browser");
    expect(r[0]!.why).toContain("tags: screenshot, rtl");
    expect(r[0]!.how).toContain("run the thing");
    expect(r[0]!.allowed).toBe(true);
    expect(r[0]!.score).toBeGreaterThan(DEFAULT_TOOLS_CFG.minScore);
  });

  test("the same query twice gives the same order", () => {
    const { cat } = open();
    const a = cat.find("deploy screenshot code search", ctx).map((m) => [m.id, m.score]);
    const b = cat.find("deploy screenshot code search", ctx).map((m) => [m.id, m.score]);
    expect(a.length).toBeGreaterThan(1);
    expect(a).toEqual(b);
  });

  test("only stop words: [] plus one tools_miss with terms only", () => {
    const { cat, ledger } = open();
    expect(cat.find("please do the", ctx)).toEqual([]);
    const ev = ledger.listEvents({ kind: "tools_miss" });
    expect(ev.length).toBe(1);
    expect(ev[0]!.data).toMatchObject({ project: "waselni", terms: [] });
  });

  test("a miss records the query words, capped at 24, never the brief", () => {
    const { cat, ledger } = open();
    const words = Array.from({ length: 40 }, (_, i) => `zebra${i}`);
    expect(cat.find(`SENTINEL-BRIEF ${words.join(" ")}`, ctx)).toEqual([]);
    const ev = ledger.listEvents({ kind: "tools_miss" });
    expect(ev.length).toBe(1);
    const terms = (ev[0]!.data as { terms: string[] }).terms;
    expect(terms.length).toBeLessThanOrEqual(24);
    expect(JSON.stringify(ev[0]!.data)).not.toContain("SENTINEL-BRIEF ");
  });

  test("a weak match below minScore is a miss", () => {
    const { cat, ledger } = open({ cfg: { minScore: 1000 } });
    expect(cat.find("take a screenshot", ctx)).toEqual([]);
    expect(ledger.listEvents({ kind: "tools_miss" }).length).toBe(1);
  });

  test("scope: a card for eticket-v3 is hidden elsewhere, shown allowed:false when showDisallowed", () => {
    const q = "count eticket bookings by status";
    expect(open().cat.find(q, ctx).map((m) => m.id)).not.toContain("eticket-data");
    const shown = open({ cfg: { showDisallowed: true } }).cat.find(q, ctx).find((m) => m.id === "eticket-data");
    expect(shown?.allowed).toBe(false);
    expect(shown?.reason).toContain("eticket-v3");
    const own = open().cat.find(q, { project: "eticket-v3", folder: "/tmp/e" }).find((m) => m.id === "eticket-data");
    expect(own?.allowed).toBe(true);
  });

  test("candidate and retired cards are never returned", () => {
    const { cat } = open({ cfg: { showDisallowed: true, minScore: 0.000001 } });
    const ids = [...cat.find("unicorn rendering", ctx), ...cat.find("dragon rendering", ctx)].map((m) => m.id);
    expect(ids).not.toContain("draft-card");
    expect(ids).not.toContain("old-card");
  });

  test("global skills are found; another project's skills never appear", () => {
    const skills: SkillSource = {
      global: () => [{ id: "taste-skill", when: "Anti-slop frontend design for landing pages." }],
      project: (folder) => (folder.endsWith("waselni") ? [{ id: "waselni-ota", when: "Publish an OTA update for the waselni app." }] : []),
    };
    const { cat } = open({ skills });
    const mine = cat.find("publish an OTA update", { project: "waselni", folder: "/x/waselni" });
    expect(mine[0]).toMatchObject({ id: "waselni-ota", kind: "skill", allowed: true });
    expect(cat.find("publish an OTA update", { project: "eticket-v3", folder: "/x/eticket-v3" }).map((m) => m.id)).not.toContain("waselni-ota");
    expect(cat.find("landing pages design", ctx)[0]!.id).toBe("taste-skill");
    // the project rows leave no trace in the index
    expect(cat.find("publish an OTA update", { project: "eticket-v3", folder: "/x/eticket-v3" })).toEqual([]);
  });

  test("a skill generated from a card (neo-tool-*) is not listed twice", () => {
    const skills: SkillSource = { global: () => [{ id: "neo-tool-shared-browser", when: "Use when a test needs a real browser: screenshots." }], project: () => [] };
    const ids = open({ skills }).cat.find("screenshot browser", ctx).map((m) => m.id);
    expect(ids).toEqual(["shared-browser"]);
  });

  test("usage boost: more ok uses ranks first; p50 only for relay cards", () => {
    const twins = [
      { id: "twin-a", when: "Use to frobnicate widgets.", tags: ["frob"], examples: ["frobnicate"] },
      { id: "twin-b", when: "Use to frobnicate widgets.", tags: ["frob"], examples: ["frobnicate"] },
    ];
    const usage: UsageSource = { okUses: () => new Map([["twin-b", 5]]), p50: () => 120 };
    const { cat } = open({ cards: twins, usage, cfg: { minScore: 0 } });
    const r = cat.find("frobnicate widgets", ctx);
    expect(r.map((m) => m.id)).toEqual(["twin-b", "twin-a"]);
    expect(r[0]!.p50Ms).toBeUndefined(); // neither is an api relay card
    expect(open({ cards: twins, cfg: { minScore: 0 } }).cat.find("frobnicate widgets", ctx).map((m) => m.id)).toEqual(["twin-a", "twin-b"]);
  });

  test("a 50 kB brief returns, and an Arabic brief is [] without throwing", () => {
    const { cat } = open();
    const big = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(" ") + " screenshot";
    const t0 = Date.now();
    expect(cat.find(big, ctx)[0]!.id).toBe("shared-browser");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(cat.find("التقط لقطة شاشة للصفحة", ctx)).toEqual([]);
  });

  test("FTS operator characters in the brief do not throw", () => {
    const { cat } = open();
    expect(() => cat.find('NEAR( "x" OR AND * ^ ) screenshot -rtl', ctx)).not.toThrow();
  });

  test("limit is honoured", () => {
    const { cat } = open();
    expect(cat.find("deploy screenshot code search", { ...ctx, limit: 1 }).length).toBe(1);
  });
});

describe("fsSkillSource", () => {
  test("reads descriptions, skips broken front matter, reads project skills from the folder", () => {
    const home = mkdtempSync(join(tmpdir(), "neo-claude-"));
    const mk = (base: string, name: string, text: string) => {
      mkdirSync(join(base, name), { recursive: true });
      writeFileSync(join(base, name, "SKILL.md"), text);
    };
    mk(join(home, "skills"), "good", "---\nname: good-skill\ndescription: Does a good thing for tests.\n---\nbody");
    mk(join(home, "skills"), "broken", "---\nname: [oops\n: :\n---\nbody");
    mk(join(home, "skills"), "nofront", "no front matter");
    mk(join(home, "skills"), "nodesc", "---\nname: nodesc\n---\nbody");
    const proj = mkdtempSync(join(tmpdir(), "neo-proj-"));
    mk(join(proj, ".claude", "skills"), "p", "---\nname: proj-skill\ndescription: Project only.\n---\n");
    const src = fsSkillSource({ claudeDir: home });
    expect(src.global()).toEqual([{ id: "good-skill", when: "Does a good thing for tests." }]);
    expect(src.project(proj)).toEqual([{ id: "proj-skill", when: "Project only." }]);
    expect(src.project("/nonexistent-folder")).toEqual([]);
  });
});
