// One reader of a shell command's shape, shared by the project fence (ADR-0031), the side-lane rules
// (ADR-0057) and the push rule (ADR-0069). It splits a command into simple commands (quote- and
// heredoc-aware, `splitCommands`), follows `cd`/`pushd`/`env -C`,
// strips leading `VAR=value` words, and checks nested `sh -c '…'` / `eval '…'` code first. Defense in
// depth only: an interpreter that writes files itself (`python -c`) is not read.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Git subcommands that change a repository (a branch, a commit, a worktree, the index or the tree). */
export const GIT_WRITE = /^(commit|checkout|switch|branch|merge|rebase|reset|tag|stash|worktree|cherry-pick|revert|am|apply|add|rm|mv|restore|push|pull|init|update-ref|symbolic-ref)$/;
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

// `sh -c`, and combined flags that include c (`bash -lc`, `sh -ec`).
const NESTED = /\b(?:(?:ba|z|da)?sh\s+(?:-\w+\s+)*-[A-Za-z]*c[A-Za-z]*|eval)\s+("(?:[^"\\]|\\.)*"|'[^']*')/g;

/** Words that open or continue a compound command; the simple command comes after them. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"]);

/** Split a shell line into its simple commands: at `;`, newline, `&&`, `||`, `|`, `|&` and a lone `&`, but
 *  never inside quotes, after a backslash, or in a heredoc body (`<<EOF` … `EOF`, `<<-EOF` with tabs), and
 *  not at the `&` of a redirection (`2>&1`, `&>f`). A backslash-newline continues the command. */
export function splitCommands(command: string): string[] {
  const text = command.replace(/\\\n/g, " ");
  const out: string[] = [];
  const heredocs: { tag: string; tabs: boolean }[] = [];
  let cur = "";
  let q: string | undefined;
  const end = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && i + 1 < text.length) cur += text[++i];
      else if (c === q) q = undefined;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      cur += c + text[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(text.slice(i));
      if (m) {
        heredocs.push({ tag: m[3]!, tabs: m[1] === "-" });
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "\n") {
      end();
      // The bodies of the heredocs opened on this line follow it: text up to each end marker.
      for (const h of heredocs) {
        while (i < text.length) {
          const nl = text.indexOf("\n", i + 1);
          const line = text.slice(i + 1, nl < 0 ? text.length : nl);
          i = nl < 0 ? text.length : nl;
          if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.tag) break;
        }
      }
      heredocs.length = 0;
      continue;
    }
    if (c === ";") {
      end();
      continue;
    }
    if (c === "|") {
      end();
      if (text[i + 1] === "|" || text[i + 1] === "&") i++;
      continue;
    }
    if (c === "&") {
      if (text[i + 1] === "&") {
        end();
        i++;
      } else if (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">") cur += c;
      else end();
      continue;
    }
    cur += c;
  }
  end();
  return out;
}

/** `p` with symlinks resolved on its longest existing prefix (the rest may not exist yet), so a link
 *  that points elsewhere is judged where it really leads. */
export function realish(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (head !== dirname(head)) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      tail.push(basename(head));
      head = dirname(head);
    }
  }
  return p;
}

/** Where a command redirects its output: each unquoted `>`/`>>` (with an optional fd) and its target,
 *  quoted or not. A `>` inside quotes is text; `>&2` duplicates a descriptor and writes no file. */
function redirectTargets(seg: string): string[] {
  const out: string[] = [];
  let q: string | undefined;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c !== ">") continue;
    let j = i + 1;
    if (seg[j] === ">") j++;
    if (seg[j] === "&") {
      i = j;
      continue;
    }
    while (seg[j] === " " || seg[j] === "\t") j++;
    let target = "";
    if (seg[j] === '"' || seg[j] === "'") {
      const close = seg.indexOf(seg[j]!, j + 1);
      target = seg.slice(j + 1, close < 0 ? undefined : close);
      j = close < 0 ? seg.length : close + 1;
    } else {
      while (j < seg.length && !/[\s;&|<>]/.test(seg[j]!)) target += seg[j++];
    }
    if (target) out.push(target);
    i = j - 1;
  }
  return out;
}

/** Commands that run another command: the words after them are the real command. Each entry lists the
 *  wrapper's flags that take a value; `timeout` also takes its duration. */
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "-R"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nohup: new Set(),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]),
};

/** The words with leading wrapper commands (`sudo -E`, `timeout 30`, `nohup`, `xargs -n1`, …) removed. */
function unwrap(words: string[]): string[] {
  let w = words;
  for (let guard = 0; guard < 8 && w.length; guard++) {
    const flags = WRAPPERS[w[0]!];
    if (!flags) return w;
    const wrapper = w[0]!;
    let i = 1;
    while (i < w.length && w[i]!.startsWith("-")) i += flags.has(w[i]!) ? 2 : 1;
    if (wrapper === "timeout" && i < w.length) i++; // the duration
    w = w.slice(i);
  }
  return w;
}

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
  for (const raw of splitCommands(command.replace(NESTED, " "))) {
    const seg = raw.trim().replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "");
    let words = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((w) => expand(w.replace(/["']/g, ""))) ?? [];
    while (words.length && KEYWORDS.has(words[0]!)) words = words.slice(1);
    let gitRepoVar: string | undefined;
    while (words.length && /^\w+=/.test(words[0]!)) {
      const [k, ...v] = words[0]!.split("=");
      if (k === "GIT_DIR" || k === "GIT_WORK_TREE") gitRepoVar = v.join("=").replace(/\/\.git$/, "");
      words = words.slice(1);
    }
    // Wrappers and `env` may come in any order (`sudo env -C dir git …`, `env FOO=1 timeout 5 git …`).
    for (let guard = 0; guard < 4; guard++) {
      const before = words.length;
      words = unwrap(words);
      if (words[0] === "env") {
        words = words.slice(1);
        // env's own options: -C DIR moves the folder; -u NAME takes a value; -i and the rest do not.
        while (words.length && words[0]!.startsWith("-")) {
          if (words[0] === "-C" && words[1]) {
            cwd = resolve(resolve(cwd), words[1]);
            words = words.slice(2);
          } else words = words.slice(words[0] === "-u" || words[0] === "--unset" ? 2 : 1);
        }
        while (words.length && /^\w+=/.test(words[0]!)) words = words.slice(1);
      }
      if (words.length === before) break;
    }
    if (words.length === 0) continue;
    if ((words[0] === "cd" || words[0] === "pushd") && words[1]) {
      cwd = resolve(resolve(cwd), words[1]);
      continue;
    }
    // A redirection writes its target, quoted or not; a `>` inside quotes is text.
    const redirects = redirectTargets(seg).map(expand);
    const hit = visit({ cwd, words, redirects, ...(gitRepoVar ? { gitRepoVar } : {}) });
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** A `git` command's repository (absolute), subcommand and the words after it; undefined when the
 *  segment is not git. Reads `-C`, `--git-dir`/`--work-tree` (both forms) and `GIT_DIR=`. */
export function gitCall(seg: BashSegment): { repo: string; sub: string; args: string[] } | undefined {
  const { words, cwd } = seg;
  if (basename(words[0] ?? "") !== "git") return undefined; // `git`, or `/usr/bin/git`
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
