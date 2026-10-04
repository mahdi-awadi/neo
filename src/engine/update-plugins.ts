// The `plugins` update source (ADR-0009): Claude Code plugins (and the skills they carry), through
// the `claude plugin` CLI. Only ENABLED, user-scope plugins are updated — a disabled plugin loads
// nowhere. The CLI keeps the old version's folder, so a rollback is restoring the plugin's entry in
// `installed_plugins.json`. A running session may still read the old folder, so nothing runs while
// a session is busy (the orchestrator retries when the engine is idle).
import { join } from "node:path";
import type { ItemResult, RunContext, UpdateSource, UpdateSys } from "./updater";
import { breakingLines, notesBetween } from "./updater";

const MIN = 60_000;
const TIMEOUTS = { list: MIN, marketplace: 5 * MIN, update: 5 * MIN, verify: 2 * MIN };
/** Release-note files a plugin may ship, first match wins. */
const NOTES_FILES = ["CHANGELOG.md", "RELEASE-NOTES.md", "RELEASE_NOTES.md", "CHANGES.md"];

export interface PluginsSourceDeps {
  sys: UpdateSys;
  /** `~/.claude/plugins/installed_plugins.json` — the CLI's registry of installed versions. */
  pluginsFile: string;
}

interface ListedPlugin {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
}

interface PluginEntry {
  scope: string;
  installPath: string;
  version: string;
  [k: string]: unknown;
}

/** The last JSON object line of a CLI's stdout (progress text may come before it). */
function lastJson<T>(out: string): T | undefined {
  for (const line of out.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line) as T;
    } catch {
      // not the JSON line
    }
  }
  try {
    return JSON.parse(out) as T;
  } catch {
    return undefined;
  }
}

export function pluginsSource(d: PluginsSourceDeps): UpdateSource {
  const { sys } = d;
  const claude = (args: string[], timeoutMs: number) => sys.exec(["claude", "plugin", ...args], { timeoutMs });

  const registry = () => {
    const text = sys.readFile(d.pluginsFile);
    return text ? (JSON.parse(text) as { version: number; plugins: Record<string, PluginEntry[]> }) : undefined;
  };
  const entryOf = (id: string): PluginEntry | undefined => registry()?.plugins[id]?.find((e) => e.scope === "user");

  /** Put a plugin's user-scope entry back to `old` (its folder must still exist). */
  const restore = (id: string, old: PluginEntry): string | undefined => {
    if (!sys.exists(old.installPath)) return `the old folder ${old.installPath} is gone`;
    const reg = registry();
    if (!reg) return `cannot read ${d.pluginsFile}`;
    const list = reg.plugins[id] ?? [];
    reg.plugins[id] = [...list.filter((e) => e.scope !== old.scope), old];
    sys.writeFile(d.pluginsFile, JSON.stringify(reg, null, 2));
    return undefined;
  };

  /** Validate the manifest and load the plugin's inventory. Returns why it failed, or undefined. */
  const verify = async (id: string, path: string): Promise<string | undefined> => {
    const v = await claude(["validate", path, "--json"], TIMEOUTS.verify);
    const report = lastJson<{ success?: boolean; manifest?: { errors?: unknown[] } }>(v.out);
    if (v.code !== 0 || report?.success !== true) {
      const errs = report?.manifest?.errors?.map(String).join("; ");
      return `validate failed${errs ? `: ${errs}` : ""}`;
    }
    const det = await claude(["details", id], TIMEOUTS.verify);
    if (det.code !== 0) return `details failed: ${(det.err || det.out).trim().slice(0, 200)}`;
    return undefined;
  };

  const notesFor = (path: string, from: string, to: string): string[] => {
    for (const f of NOTES_FILES) {
      const text = sys.readFile(join(path, f));
      if (text) return breakingLines(notesBetween(text, from, to));
    }
    return [];
  };

  const updateOne = async (p: ListedPlugin, ctx: RunContext): Promise<ItemResult> => {
    const base: Omit<ItemResult, "outcome"> = { category: "plugins", id: p.id, from: p.version };
    const old = entryOf(p.id);
    const r = await claude(["update", p.id, "--json"], TIMEOUTS.update);
    const res = lastJson<{ outcome?: string; updateOutcome?: string; newVersion?: string; message?: string }>(r.out);
    if (r.code !== 0 || res?.outcome !== "ok") {
      return { ...base, outcome: "failed", detail: (res?.message ?? (r.err || r.out)).trim().slice(0, 300) };
    }
    if (res.updateOutcome !== "updated" || !res.newVersion || res.newVersion === p.version) return { ...base, outcome: "up_to_date" };
    const to = res.newVersion;
    const now = entryOf(p.id);
    if (!old || !now) return { ...base, to, outcome: "applied", detail: "applied, but its registry entry could not be read — no rollback point" };

    const breaking = notesFor(now.installPath, p.version, to);
    if (breaking.length && ctx.holdBreaking) {
      const why = restore(p.id, old);
      return why
        ? { ...base, to, outcome: "applied", breaking, detail: `release notes flag a breaking change, and holding it failed (${why})` }
        : { ...base, to, outcome: "held", breaking, detail: `release notes flag a breaking change — /updates apply ${p.id}` };
    }
    const bad = await verify(p.id, now.installPath);
    if (bad) {
      const why = restore(p.id, old);
      return why
        ? { ...base, to, outcome: "failed", detail: `${bad}; rollback failed: ${why}` }
        : { ...base, to, outcome: "rolled_back", detail: `${bad} — ${p.version} restored` };
    }
    return {
      ...base,
      to,
      outcome: "applied",
      breaking: breaking.length ? breaking : undefined,
      detail: "verified; new sessions load it",
      undo: { entry: old, newEntry: now },
    };
  };

  return {
    category: "plugins",
    async run(ctx) {
      const list = await claude(["list", "--json"], TIMEOUTS.list);
      const all = lastJson<ListedPlugin[]>(list.out);
      if (list.code !== 0 || !Array.isArray(all)) return [{ category: "plugins", id: "plugins", outcome: "failed", detail: "claude plugin list failed" }];
      const targets = all.filter((p) => p.enabled && p.scope === "user" && (!ctx.only || ctx.only === p.id || ctx.only === "plugins"));
      if (targets.length === 0) return [];
      if (ctx.busy) return targets.map((p) => ({ category: "plugins" as const, id: p.id, outcome: "deferred" as const, from: p.version, detail: "a session is running — applied when the engine is idle" }));
      // Availability is only known by updating (the catalogs carry a source ref, not a version).
      if (!ctx.autoApply) return targets.map((p) => ({ category: "plugins" as const, id: p.id, outcome: "skipped" as const, from: p.version, detail: "auto-apply is off for plugins" }));
      await claude(["marketplace", "update"], TIMEOUTS.marketplace);
      const out: ItemResult[] = [];
      for (const p of targets) out.push(await updateOne(p, ctx));
      return out;
    },
    async rollback(last) {
      const undo = last.undo as { entry?: PluginEntry } | undefined;
      const base: Omit<ItemResult, "outcome"> = { category: "plugins", id: last.id, from: last.to, to: last.from };
      if (!undo?.entry) return { ...base, outcome: "failed", detail: "no rollback point recorded" };
      const why = restore(last.id, undo.entry);
      if (why) return { ...base, outcome: "failed", detail: why };
      const bad = await verify(last.id, undo.entry.installPath);
      return bad ? { ...base, outcome: "failed", detail: `restored, but ${bad}` } : { ...base, outcome: "rolled_back", detail: "new sessions load the old version" };
    },
  };
}
