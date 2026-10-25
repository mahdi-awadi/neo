import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOOLS_CFG, loadCards, type ToolCard } from "../src/engine/tools-catalogue";
import { installCatalogue, renderSkills } from "../tools/catalogue/install";

const tmp: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "cat-")); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true }); });

const card = (o: Partial<ToolCard> = {}): ToolCard => ({
  id: "demo", kind: "cli", status: "active", owner: "neo", when: "Use it", scope: "all", env: [], cost: "free", limits: "none",
  dataLeavesHost: false, tags: ["demo"], examples: ["do a demo"], body: "## How to call\nrun it\n## When NOT to use\nnever\n", file: "demo.md", ...o,
});
const text = (id: string, status = "active", extra = "") => `---
id: ${id}
kind: cli
status: ${status}
owner: neo
when: "Use ${id}"
scope: all
env: []
cost: free
limits: none
dataLeavesHost: false
tags: [demo]
examples: ["do a demo"]
${extra}---
## How to call
run
## When NOT to use
never
`;
const src = (files: Record<string, string>) => { const d = mk(); for (const [n, t] of Object.entries(files)) writeFileSync(join(d, `${n}.md`), t); return d; };
const fm = (s: string) => Bun.YAML.parse(/^---\n([\s\S]*?)\n---/.exec(s)![1]!) as Record<string, unknown>;

describe("renderSkills", () => {
  test("one skill per active card; none for candidate or retired", () => {
    const out = renderSkills([card({ id: "a" }), card({ id: "b", status: "candidate" }), card({ id: "c", status: "retired" })]);
    expect(out.map((s) => s.dir)).toEqual(["neo-tool-a"]);
    expect(Object.keys(out[0]!.files).sort()).toEqual([".neo-tool", "SKILL.md"]);
  });
  test("recipe cards become neo-recipe-<id>", () => {
    const out = renderSkills([card({ id: "r", kind: "recipe", steps: [{ card: "a", do: "x" }, { card: "b", do: "y" }] })]);
    expect(out[0]!.dir).toBe("neo-recipe-r");
    expect(out[0]!.files["SKILL.md"]).toContain("1. a: x");
  });
  test("description is quoted and parses back with : \" #", () => {
    const when = 'Use: "quotes" # not a comment';
    const md = renderSkills([card({ when, scope: ["p1", "p2"] })])[0]!.files["SKILL.md"]!;
    const y = fm(md);
    expect(y.name).toBe("neo-tool-demo");
    expect(y.description).toBe(`${when} (scope: p1, p2)`);
  });
});

describe("installCatalogue", () => {
  test("writes active skills, removes marked stale folders, keeps unmarked", () => {
    const s = src({ demo: text("demo"), cand: text("cand", "candidate") });
    const claudeDir = mk();
    const skills = join(claudeDir, "skills");
    mkdirSync(join(skills, "neo-tool-old"), { recursive: true });
    writeFileSync(join(skills, "neo-tool-old", ".neo-tool"), "");
    mkdirSync(join(skills, "neo-tool-hand"), { recursive: true });
    writeFileSync(join(skills, "neo-tool-hand", "SKILL.md"), "mine");
    const r = installCatalogue({ src: s, claudeDir, cfg: DEFAULT_TOOLS_CFG });
    expect(r.errors).toEqual([]);
    expect(r.removed).toEqual(["neo-tool-old"]);
    expect(existsSync(join(skills, "neo-tool-demo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skills, "neo-tool-cand"))).toBe(false);
    expect(existsSync(join(skills, "neo-tool-old"))).toBe(false);
    expect(readFileSync(join(skills, "neo-tool-hand", "SKILL.md"), "utf8")).toBe("mine");
  });
  test("a second run leaves mtimes unchanged", async () => {
    const s = src({ demo: text("demo") });
    const claudeDir = mk();
    installCatalogue({ src: s, claudeDir, cfg: DEFAULT_TOOLS_CFG });
    const f = join(claudeDir, "skills", "neo-tool-demo", "SKILL.md");
    const m1 = statSync(f).mtimeMs;
    await Bun.sleep(20);
    const r = installCatalogue({ src: s, claudeDir, cfg: DEFAULT_TOOLS_CFG });
    expect(statSync(f).mtimeMs).toBe(m1);
    expect(r.written).toEqual([]);
  });
  test("catalogue errors leave skills/ untouched", () => {
    const claudeDir = mk();
    const good = src({ demo: text("demo") });
    installCatalogue({ src: good, claudeDir, cfg: DEFAULT_TOOLS_CFG });
    const before = readFileSync(join(claudeDir, "skills", "neo-tool-demo", "SKILL.md"), "utf8");
    const bad = src({ demo: text("demo"), broken: "no front matter" });
    const r = installCatalogue({ src: bad, claudeDir, cfg: DEFAULT_TOOLS_CFG });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.written).toEqual([]);
    expect(readdirSync(join(claudeDir, "skills"))).toEqual(["neo-tool-demo"]);
    expect(readFileSync(join(claudeDir, "skills", "neo-tool-demo", "SKILL.md"), "utf8")).toBe(before);
  });
  test("dryRun writes nothing but reports", () => {
    const claudeDir = mk();
    const r = installCatalogue({ src: src({ demo: text("demo") }), claudeDir, cfg: DEFAULT_TOOLS_CFG, dryRun: true });
    expect(r.written.length).toBeGreaterThan(0);
    expect(existsSync(join(claudeDir, "skills"))).toBe(false);
  });
  test("the real docs/tools catalogue installs into a temp dir", () => {
    const claudeDir = mk();
    const r = installCatalogue({ src: join(import.meta.dir, "..", "docs", "tools"), claudeDir, cfg: DEFAULT_TOOLS_CFG });
    expect(r.errors).toEqual([]);
    const active = loadCards(join(import.meta.dir, "..", "docs", "tools"), DEFAULT_TOOLS_CFG).cards.filter((c) => c.status === "active");
    expect(readdirSync(join(claudeDir, "skills")).length).toBe(active.length);
  });
});
