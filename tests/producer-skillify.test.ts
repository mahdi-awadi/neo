// The skillify producer (ADR-0044 Phase 4, spec A7 + A9 #12): a task the operator gave a project 3 times
// in 30 days, with no tool or skill that fits it, becomes one attention item "make it a recipe or a skill?".
// The engine only counts; a worker writes the recipe or skill.
import { expect, test } from "bun:test";
import { openLedger, type Ledger } from "../src/engine/ledger";
import { reconcileAll } from "../src/engine/attention";
import { ATTENTION_BRIEFS } from "../src/engine/attention-briefs";
import { continuationBrief } from "../src/engine/context-policy";
import { DEFAULT_TOOLS_CFG, openCatalogue, type ToolCard } from "../src/engine/tools-catalogue";
import { SKILLIFY_KINDS, skillifyDrafts, skillifyTick } from "../src/engine/producers/skillify";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const W = { project: "waselni", folder: "/home/waselni" };

function todo(led: Ledger, brief: string, at = NOW - DAY, where = W, extra: { planId?: number } = {}) {
  return led.addTodo({ ...where, brief, workClass: "interactive", createdBy: "operator", ...extra }, at);
}

const recipe: ToolCard = {
  id: "deploy-check", kind: "recipe", status: "active", owner: "neo", when: "Use after a deploy to check the deploy is healthy.",
  scope: "all", env: [], cost: "c", limits: "l", dataLeavesHost: false, tags: ["deploy", "check", "prod"], examples: ["deploy check waselni prod"],
  body: "## How to call\nx\n## When NOT to use\ny", file: "deploy-check.md",
};
/** Unrelated cards, so BM25 has a real corpus (with one document every score is near 0). */
const others: ToolCard[] = ["alpha", "beta", "gamma"].map((id) => ({ ...recipe, kind: "cli", id, when: `Use to ${id} the widgets.`, tags: [id], examples: [`${id} widgets`], file: `${id}.md` }));
const emptyCatalogue = (led: Ledger) => openCatalogue({ cards: [], cfg: DEFAULT_TOOLS_CFG, ledger: led });

test("3 todos with the same words (reordered) in 30 days → 1 item; a 4th → still 1", () => {
  const led = openLedger(":memory:");
  todo(led, "deploy check waselni prod");
  todo(led, "Prod deploy check, waselni!\nmore detail on the second line");
  todo(led, "waselni: check the prod deploy");
  const d = skillifyDrafts({ ledger: led, catalogue: emptyCatalogue(led), cfg: DEFAULT_TOOLS_CFG }, NOW);
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({ project: "waselni", folder: "/home/waselni", source: "skillify", kind: "skillify_repeat", key: "skillify:check deploy prod waselni", severity: "low" });
  expect(d[0]!.title).toContain("3 times");
  reconcileAll(led, "skillify", d, NOW);
  todo(led, "deploy check waselni prod");
  const d2 = skillifyDrafts({ ledger: led, catalogue: emptyCatalogue(led), cfg: DEFAULT_TOOLS_CFG }, NOW);
  expect(d2).toHaveLength(1);
  expect(d2[0]!.title).toContain("4 times");
  reconcileAll(led, "skillify", d2, NOW + 1);
  expect(led.attentionRows("waselni", "skillify")).toHaveLength(1);
});

test("a recipe or skill that already fits the task → no item, and no tools_miss is recorded", () => {
  const led = openLedger(":memory:");
  for (let i = 0; i < 3; i++) todo(led, "deploy check waselni prod");
  const catalogue = openCatalogue({ cards: [recipe, ...others], cfg: DEFAULT_TOOLS_CFG, ledger: led });
  expect(skillifyDrafts({ ledger: led, catalogue, cfg: DEFAULT_TOOLS_CFG }, NOW)).toEqual([]);
  for (let i = 0; i < 3; i++) todo(led, "rotate the signing keystore");
  expect(skillifyDrafts({ ledger: led, catalogue, cfg: DEFAULT_TOOLS_CFG }, NOW)).toHaveLength(1);
  expect(led.countEvents({ kind: "tools_miss", since: 0 })).toBe(0);
});

test("another project's todos, older todos and fewer than skillifyMin do not count", () => {
  const led = openLedger(":memory:");
  todo(led, "deploy check waselni prod");
  todo(led, "deploy check waselni prod");
  todo(led, "deploy check waselni prod", NOW - DAY, { project: "eticket-v3", folder: "/home/eticket-v3" });
  todo(led, "deploy check waselni prod", NOW - 31 * DAY);
  expect(skillifyDrafts({ ledger: led, catalogue: emptyCatalogue(led), cfg: DEFAULT_TOOLS_CFG }, NOW)).toEqual([]);
  expect(skillifyDrafts({ ledger: led, catalogue: emptyCatalogue(led), cfg: { ...DEFAULT_TOOLS_CFG, skillifyMin: 2 } }, NOW)).toHaveLength(1);
});

test("engine-made todos are not repeats: plan steps, continuations and todos opened from an attention item", () => {
  const led = openLedger(":memory:");
  for (let i = 0; i < 3; i++) todo(led, "Execute the plan at docs/p.md task 1", NOW - DAY, W, { planId: 7 });
  for (let i = 0; i < 3; i++) todo(led, continuationBrief(`fix the login bug ${i}`));
  for (let i = 0; i < 3; i++) {
    const t = todo(led, "Project gold found something this project owns: x");
    const id = led.insertAttention({ ...W, source: "note", kind: "note_finding", key: `n${i}`, title: "x", severity: "normal" }, NOW);
    led.updateAttention(id, { todoId: t.id });
  }
  expect(skillifyDrafts({ ledger: led, catalogue: emptyCatalogue(led), cfg: DEFAULT_TOOLS_CFG }, NOW)).toEqual([]);
});

test("every skillify kind has a todo brief", () => {
  for (const k of SKILLIFY_KINDS) expect(ATTENTION_BRIEFS[k]).toBeDefined();
});

test("skillifyTick runs once a day: an item opens, and resolves once a fitting recipe exists", () => {
  const led = openLedger(":memory:");
  for (let i = 0; i < 3; i++) todo(led, "deploy check waselni prod");
  const tick = skillifyTick({ ledger: led, catalogue: emptyCatalogue(led), cfg: DEFAULT_TOOLS_CFG, keepResolvedMs: 30 * DAY });
  tick(NOW);
  expect(led.attentionRows("waselni", "skillify").filter((r) => r.resolvedAt === undefined)).toHaveLength(1);
  const withRecipe = skillifyTick({ ledger: led, catalogue: openCatalogue({ cards: [recipe, ...others], cfg: DEFAULT_TOOLS_CFG, ledger: led }), cfg: DEFAULT_TOOLS_CFG, keepResolvedMs: 30 * DAY });
  withRecipe(NOW);
  expect(led.attentionRows("waselni", "skillify")[0]!.resolvedAt).toBe(NOW);
  for (let i = 0; i < 3; i++) todo(led, "rotate the signing keystore");
  tick(NOW + DAY - 1); // within the day: no pass
  expect(led.attentionRows("waselni", "skillify").filter((r) => r.resolvedAt === undefined)).toHaveLength(0);
  tick(NOW + DAY);
  // `tick` has no recipe, so the deploy task is back too (the same row reopens).
  expect(led.attentionRows("waselni", "skillify").filter((r) => r.resolvedAt === undefined).map((r) => r.key).sort()).toEqual(["skillify:check deploy prod waselni", "skillify:keystore rotate signing"]);
});
