// The filesystem adapter of the `SkillSource` seam (ADR-0044, spec A3). It reads installed skill
// DESCRIPTIONS only, and only reads: `~/.claude/skills/*/SKILL.md`, the enabled plugins' skill folders,
// and `<folder>/.claude/skills/*/SKILL.md` for the calling project. A skill with broken front matter, or
// without a description, is skipped. Nothing here ever throws or writes. Plain code, no AI.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillRow, SkillSource } from "./tools-catalogue";

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
/** A description longer than this is cut: the index needs the gist, not a manual. */
const MAX_WHEN_CHARS = 600;

/** `<dir>/*\/SKILL.md` → rows. `prefix` namespaces plugin skills so two plugins never collide. */
function readSkillDir(dir: string, prefix = ""): SkillRow[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const rows: SkillRow[] = [];
  for (const name of names) {
    try {
      const m = FRONT_RE.exec(readFileSync(join(dir, name, "SKILL.md"), "utf8"));
      if (!m) continue;
      const fm = Bun.YAML.parse(m[1]!) as Record<string, unknown> | null;
      const desc = fm && typeof fm.description === "string" ? fm.description.replace(/\s+/g, " ").trim() : "";
      if (!desc) continue;
      const id = typeof fm!.name === "string" && fm!.name.trim() ? fm!.name.trim() : name;
      rows.push({ id: prefix + id, when: desc.slice(0, MAX_WHEN_CHARS) });
    } catch {
      /* broken front matter or unreadable file: skip this skill */
    }
  }
  return rows;
}

/** The skill folders of the plugins enabled in `<claudeDir>/settings.json` (only `enabledPlugins` is read). */
function enabledPluginSkillDirs(claudeDir: string): Array<{ plugin: string; dir: string }> {
  try {
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as { enabledPlugins?: Record<string, unknown> };
    const installed = JSON.parse(readFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "utf8")) as {
      plugins?: Record<string, Array<{ installPath?: unknown }>>;
    };
    const out: Array<{ plugin: string; dir: string }> = [];
    for (const [key, on] of Object.entries(settings.enabledPlugins ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (on !== true) continue;
      const path = installed.plugins?.[key]?.[0]?.installPath;
      if (typeof path === "string" && existsSync(join(path, "skills"))) out.push({ plugin: key.split("@")[0]!, dir: join(path, "skills") });
    }
    return out;
  } catch {
    return [];
  }
}

export function fsSkillSource(opts: { claudeDir?: string } = {}): SkillSource {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  return {
    global: () => [
      ...readSkillDir(join(claudeDir, "skills")),
      ...enabledPluginSkillDirs(claudeDir).flatMap((p) => readSkillDir(p.dir, `${p.plugin}:`)),
    ],
    project: (folder) => readSkillDir(join(folder, ".claude", "skills")),
  };
}
