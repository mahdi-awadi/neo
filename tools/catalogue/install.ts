// Install the tools catalogue as Claude Code skills (ADR-0044): every ACTIVE card in `docs/tools/`
// becomes `<claude-dir>/skills/neo-tool-<id>/SKILL.md` (recipes: `neo-recipe-<id>`), so a worker in any
// project can find the tool. Idempotent like tools/security/install.ts: a file is rewritten only when its
// content changed, so a second run changes nothing. A folder is ours only if it holds the `.neo-tool`
// marker; unmarked folders are never touched. Any catalogue error means nothing is changed.
//
//   bun tools/catalogue/install.ts [--claude-dir ~/.claude] [--src docs/tools] [--dry-run]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOOLS_CFG, loadCards, type ToolCard, type ToolsCfg } from "../../src/engine/tools-catalogue";

export const MARKER = ".neo-tool";
const MARKER_TEXT = "Generated from the Neo tools catalogue (ADR-0044). Do not edit; run tools/catalogue/install.ts.\n";
const OURS = /^neo-(tool|recipe)-/;

export interface RenderedSkill {
  dir: string;
  files: Record<string, string>;
}

const scopeText = (c: ToolCard) => (c.scope === "all" ? "all" : c.scope.join(", "));

/** One skill per active card. The description is JSON-quoted (valid YAML) so `: " #` in `when` is safe. */
export function renderSkills(cards: ToolCard[]): RenderedSkill[] {
  return cards.filter((c) => c.status === "active").map((c) => {
    const name = `${c.kind === "recipe" ? "neo-recipe" : "neo-tool"}-${c.id}`;
    const steps = c.steps?.length ? `## Steps\n${c.steps.map((s, i) => `${i + 1}. ${s.card}: ${s.do}`).join("\n")}\n\n` : "";
    const md = `---\nname: ${name}\ndescription: ${JSON.stringify(`${c.when} (scope: ${scopeText(c)})`)}\n---\n` +
      `<!-- Generated from docs/tools/${c.file} by tools/catalogue/install.ts. Do not edit. -->\n` +
      `Scope: ${scopeText(c)}\n\n${steps}${c.body.trim()}\n`;
    return { dir: name, files: { "SKILL.md": md, [MARKER]: MARKER_TEXT } };
  }).sort((a, b) => a.dir.localeCompare(b.dir));
}

export interface InstallResult {
  /** `<dir>/<file>` entries created or changed. */
  written: string[];
  /** Stale marked folders removed. */
  removed: string[];
  errors: string[];
}

export function installCatalogue(opts: { src: string; claudeDir: string; cfg: ToolsCfg; dryRun?: boolean }): InstallResult {
  const { cards, errors } = loadCards(opts.src, opts.cfg);
  if (errors.length) return { written: [], removed: [], errors };
  const skills = join(opts.claudeDir, "skills");
  const want = renderSkills(cards);
  const wanted = new Set(want.map((s) => s.dir));
  const written: string[] = [];
  const removed: string[] = [];

  for (const s of want) {
    for (const [name, content] of Object.entries(s.files)) {
      const path = join(skills, s.dir, name);
      if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
      written.push(`${s.dir}/${name}`);
      if (opts.dryRun) continue;
      mkdirSync(join(skills, s.dir), { recursive: true });
      writeFileSync(path, content);
    }
  }
  if (existsSync(skills)) {
    for (const d of readdirSync(skills, { withFileTypes: true })) {
      if (!d.isDirectory() || !OURS.test(d.name) || wanted.has(d.name) || !existsSync(join(skills, d.name, MARKER))) continue;
      removed.push(d.name);
      if (!opts.dryRun) rmSync(join(skills, d.name), { recursive: true, force: true });
    }
  }
  return { written, removed: removed.sort(), errors: [] };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const claudeDir = arg("--claude-dir") ?? join(homedir(), ".claude");
  const src = arg("--src") ?? join(import.meta.dir, "..", "..", DEFAULT_TOOLS_CFG.catalogueDir);
  const dryRun = args.includes("--dry-run");
  const r = installCatalogue({ src, claudeDir, cfg: DEFAULT_TOOLS_CFG, dryRun });
  if (r.errors.length) {
    for (const e of r.errors) console.error(`[catalogue] ${e}`);
    console.error("[catalogue] not installed: fix the cards above (nothing was changed)");
    process.exit(1);
  }
  console.log(`[catalogue] ${dryRun ? "would write" : "wrote"} ${r.written.length} file(s), ${dryRun ? "would remove" : "removed"} ${r.removed.length} folder(s) in ${join(claudeDir, "skills")}`);
}
