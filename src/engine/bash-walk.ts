// One reader of a shell command's shape, shared by the project fence (ADR-0031) and the side-lane rules
// (ADR-0057). It splits a command into statements and pipeline parts, follows `cd`/`pushd`/`env -C`,
// strips leading `VAR=value` words, and checks nested `sh -c '…'` / `eval '…'` code first. Defense in
// depth only: an interpreter that writes files itself (`python -c`) is not read.
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Git subcommands that change a repository (a branch, a commit, a worktree, the index or the tree). */
export const GIT_WRITE = /^(commit|checkout|switch|branch|merge|rebase|reset|tag|stash|worktree|cherry-pick|revert|am|apply|add|rm|mv|restore|push|pull|init)$/;
/** Shell commands that write the file paths they are given. */
export const WRITE_CMD = /^(cp|mv|tee|mkdir|touch|rm|rmdir|rsync|install|ln|truncate)$/;

/** One simple command of a shell line. */
export interface BashSegment {
  /** The shell's current folder for this command (after any earlier `cd`/`pushd`/`env -C`). */
  cwd: string;
  /** Its words: quotes dropped, `~`/`$HOME` expanded, leading `VAR=value` and `env [-C dir]` removed. */
  words: string[];
  /** Where it redirects output (`> f`, `>> f`, `2>f`), expanded, not yet resolved. */
  redirects: string[];
  /** A leading `GIT_DIR=` / `GIT_WORK_TREE=` value (the repository git will write). */
  gitRepoVar?: string;
}

const NESTED = /\b(?:(?:ba|z|da)?sh\s+(?:-\w+\s+)*-c|eval)\s+("(?:[^"\\]|\\.)*"|'[^']*')/g;

/** Visit each simple command of `command`, run from `folder`; nested shell code first. The first value
 *  `visit` returns stops the walk and is returned. `cd`/`pushd` are followed, not visited. */
export function walkBash<T>(command: string, folder: string, visit: (seg: BashSegment) => T | undefined, depth = 0): T | undefined {
  // Code run by a nested shell is checked as a command of its own, then removed so its quoted text is
  // not read as words here.
  if (depth < 3) {
    for (const m of command.matchAll(NESTED)) {
      const hit = walkBash(m[1]!.slice(1, -1), folder, visit, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  const home = homedir();
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home);
  let cwd = folder;
  for (const statement of command.replace(NESTED, " ").split(/&&|\|\||[;\n]/)) {
    for (const raw of statement.split("|")) {
      const seg = raw.trim().replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "");
      let words = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((w) => expand(w.replace(/["']/g, ""))) ?? [];
      let gitRepoVar: string | undefined;
      while (words.length && /^\w+=/.test(words[0]!)) {
        const [k, ...v] = words[0]!.split("=");
        if (k === "GIT_DIR" || k === "GIT_WORK_TREE") gitRepoVar = v.join("=").replace(/\/\.git$/, "");
        words = words.slice(1);
      }
      if (words[0] === "env") {
        words = words.slice(1);
        if (words[0] === "-C" && words[1]) {
          cwd = resolve(resolve(cwd), words[1]);
          words = words.slice(2);
        }
      }
      if (words.length === 0) continue;
      if ((words[0] === "cd" || words[0] === "pushd") && words[1]) {
        cwd = resolve(resolve(cwd), words[1]);
        continue;
      }
      // A redirection writes its target; a `>` inside quotes is text.
      const unquoted = seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
      const redirects = [...unquoted.matchAll(/\d?>>?\s*(?!&)([^\s;&|]+)/g)].map((m) => expand(m[1]!));
      const hit = visit({ cwd, words, redirects, ...(gitRepoVar ? { gitRepoVar } : {}) });
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** A `git` command's repository (absolute), subcommand and the words after it; undefined when the
 *  segment is not git. Reads `-C`, `--git-dir`/`--work-tree` (both forms) and `GIT_DIR=`. */
export function gitCall(seg: BashSegment): { repo: string; sub: string; args: string[] } | undefined {
  const { words, cwd } = seg;
  if (words[0] !== "git") return undefined;
  let repo = seg.gitRepoVar ? resolve(resolve(cwd), seg.gitRepoVar) : resolve(cwd);
  let i = 1;
  for (; i < words.length && words[i]!.startsWith("-"); i++) {
    const w = words[i]!;
    if (w === "-C" && words[i + 1]) repo = resolve(resolve(cwd), words[++i]!);
    else if ((w === "--git-dir" || w === "--work-tree") && words[i + 1]) repo = resolve(resolve(cwd), words[++i]!.replace(/\/\.git$/, ""));
    else if (/^--(git-dir|work-tree)=/.test(w)) repo = resolve(resolve(cwd), w.slice(w.indexOf("=") + 1).replace(/\/\.git$/, ""));
    else if (w === "-c" || w === "--namespace") i++; // its value is not the subcommand
  }
  return { repo, sub: words[i] ?? "", args: words.slice(i + 1) };
}

/** The paths a file-writing command writes (`cp`/`mv`/`rsync`/`install`/`ln` their last argument or
 *  `-t DIR`; the others every path they name; `sed -i` its files). Empty for any other command. */
export function writeTargets(seg: BashSegment): string[] {
  const { words } = seg;
  const writes = WRITE_CMD.test(words[0]!) || (words[0] === "sed" && words.some((w) => w === "-i" || w.startsWith("-i")));
  if (!writes) return [];
  const t = words.indexOf("-t");
  const paths = words.slice(1).filter((w, i, all) => !w.startsWith("-") && all[i - 1] !== "-t");
  return t > 0 && words[t + 1] ? [words[t + 1]!] : /^(cp|mv|rsync|install|ln)$/.test(words[0]!) ? paths.slice(-1) : paths;
}
