// The Go modules of a repo, prepared for osv-scanner's call analysis (ADR-0066).
//
// Each module is analysed standalone (GOWORK=off), the way its own build sees it: a go.work selects one
// version of every dependency for all its modules, so a verdict made there can be about other code.
// A monorepo service often replaces a sibling module with a local folder that its Docker build fills
// (`replace example.com/app/common => ./common`, the folder only a mount placeholder). Such a folder,
// with no go.mod, is linked to the repo's own module of that path, in the overlay's upper folder only:
// the repo is never written.
//
//   bun tools/security/gomods.ts prepare --repo <repo> --upper <overlay upper> --list <modules.txt>
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface Replace {
  path: string;
  version?: string;
  to: string;
  toVersion?: string;
}

/** Folders `./...` never enters, so a module in one is not a module of this repo's build. */
const SKIP = new Set(["node_modules", "vendor", "testdata"]);

const unquote = (s: string) => s.replace(/^["`](.*)["`]$/, "$1");
const words = (line: string) => (line.replace(/\/\/.*$/, "").match(/"[^"]*"|`[^`]*`|\S+/g) ?? []).map(unquote);

/** The module path and the replace directives of a go.mod (single-line and block forms). */
export function parseGoMod(text: string): { module: string | undefined; replaces: Replace[] } {
  let module: string | undefined;
  const replaces: Replace[] = [];
  let block: string | undefined;
  for (const raw of text.split("\n")) {
    let w = words(raw);
    if (!w.length) continue;
    if (block) {
      if (w[0] === ")") {
        block = undefined;
        continue;
      }
      w = [block, ...w];
    } else if (w[1] === "(" && w.length === 2) {
      block = w[0];
      continue;
    }
    if (w[0] === "module" && w[1]) module = w[1];
    if (w[0] !== "replace") continue;
    const arrow = w.indexOf("=>");
    if (arrow !== 2 && arrow !== 3) continue;
    const r: Replace = { path: w[1]!, to: w[arrow + 1] ?? "" };
    if (arrow === 3) r.version = w[2];
    if (w[arrow + 2]) r.toVersion = w[arrow + 2];
    if (r.to) replaces.push(r);
  }
  return { module, replaces };
}

/** Every folder under the repo with a go.mod, found like `./...`: no node_modules, vendor, testdata,
 *  dot or underscore folders, and no symlinked folders. */
export function findGoModules(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === "go.mod" && e.isFile())) out.push(dir);
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".") && !e.name.startsWith("_")) walk(join(dir, e.name));
    }
  };
  walk(resolve(repo));
  return out;
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
};

/** A mount placeholder: nothing there, a broken link, or a folder with no Go code in it — no `.go` file
 *  or go.mod (searched without following links), and no link but one that is broken or loops back to the
 *  folder (such as `common -> ../common`). Real code is never hidden by a link. */
function isPlaceholder(at: string): boolean {
  let st;
  try {
    st = lstatSync(at);
  } catch {
    return true;
  }
  if (st.isSymbolicLink()) return !existsSync(at);
  if (!st.isDirectory()) return false;
  const self = realpathSync(at);
  const clean = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).every((e) => {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        if (!existsSync(p)) return true;
        const target = realpathSync(p);
        return target === self || inside(target, self);
      }
      if (e.isDirectory()) return clean(p);
      return !e.name.endsWith(".go") && e.name !== "go.mod";
    });
  return clean(at);
}

/** True when every folder from the repo root down to `at` (not `at` itself) is a real folder or does not
 *  exist yet: a path through a symlink could lead out of the repo. */
function realPathTo(root: string, at: string): boolean {
  let dir = root;
  for (const part of relative(root, dirname(at)).split(sep).filter(Boolean)) {
    dir = join(dir, part);
    try {
      if (!lstatSync(dir).isDirectory()) return false;
    } catch {
      return true; // the rest does not exist
    }
  }
  return true;
}

/** The placeholder links: a local replace target inside the repo that is only a mount placeholder, for a
 *  module path exactly one repo folder declares → that folder. Anything else stays as it is (its module
 *  then fails to load: no verdict, full severity). A target under another target, or reached through a
 *  symlink, is refused. */
export function placeholderLinks(repo: string, modules: string[]): Array<{ at: string; to: string }> {
  const root = resolve(repo);
  const mods = modules.map((dir) => ({ dir, ...parseGoMod(readFileSync(join(dir, "go.mod"), "utf8")) }));
  const dirsByPath = new Map<string, string[]>();
  for (const m of mods) if (m.module) dirsByPath.set(m.module, [...(dirsByPath.get(m.module) ?? []), m.dir]);
  const links = new Map<string, string>();
  for (const m of mods) {
    for (const r of m.replaces) {
      if (!r.to.startsWith("./") && !r.to.startsWith("../")) continue;
      const at = resolve(m.dir, r.to);
      const dirs = dirsByPath.get(r.path) ?? [];
      if (dirs.length !== 1 || dirs[0] === at || links.has(at)) continue;
      if (!inside(root, at) || !realPathTo(root, at) || !isPlaceholder(at)) continue;
      links.set(at, dirs[0]!);
    }
  }
  const all = [...links.keys()];
  return [...links]
    .filter(([at]) => !all.some((other) => other !== at && inside(other, at)))
    .map(([at, to]) => ({ at, to }));
}

/** Writes the links into the overlay's upper folder and the module list (one folder a line; a name with
 *  whitespace or a control character is left out, so the list cannot be forged). Never writes through a
 *  symlink, so nothing lands outside the upper folder. */
export function prepare(repo: string, upper: string, list: string): void {
  const root = resolve(repo);
  const top = realpathSync(upper);
  const modules = findGoModules(root).filter((d) => !/[\s\u0000-\u001f\u007f]/.test(d));
  for (const { at, to } of placeholderLinks(root, modules)) {
    const rel = relative(root, at);
    if (!realPathTo(top, join(top, rel))) continue;
    const dst = join(top, rel);
    try {
      lstatSync(dst);
      continue; // already in the upper folder
    } catch {}
    mkdirSync(dirname(dst), { recursive: true });
    if (!inside(top, realpathSync(dirname(dst))) && realpathSync(dirname(dst)) !== top) continue;
    symlinkSync(to, dst);
  }
  writeFileSync(list, modules.map((d) => `${d}\n`).join(""));
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (k: string) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const [repo, upper, list] = [arg("--repo"), arg("--upper"), arg("--list")];
  if (cmd !== "prepare" || !repo || !upper || !list) {
    console.error("usage: gomods.ts prepare --repo <repo> --upper <dir> --list <file>");
    process.exit(2);
  }
  prepare(repo, upper, list);
}
