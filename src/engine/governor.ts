// Deterministic tool policy: allow a known-safe set, path-fence writes, escalate everything
// else to a human. Default-ESCALATE: a tool this file doesn't recognize asks the operator.
// This is half of the "AI orders, engine governs" boundary (the other half is the provider
// firewall). Wired into the SDK twice, through this ONE function: a PreToolUse hook (runs before a
// project's settings allow rules; ADR-0006) and the `canUseTool` callback. Autonomous paths (loops,
// customer-driven briefs) auto-deny escalations, so for them default-escalate = default-deny.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Verdict } from "../types";

/** `governor.outOfFolderWrites`: the operator's standing answer to an out-of-folder file write
 *  (ADR-0012). "allow" = no escalation; "ask" = a fence escalation (ADR-0011). */
export type OutOfFolderWrites = "allow" | "ask";

/** The `governor` config block. See docs/CONFIG.md. */
export interface GovernorCfg {
  /** OPERATOR ORDER (2026-10-06): "allow" — writes outside the project folder never ask, for any
   *  project. Own work only: customer-sourced work and ingress keep the fence. */
  outOfFolderWrites: OutOfFolderWrites;
  /** Re-notify the operator about a still-pending approval this often (ms). 0 = never. */
  approvalRemindMs: number;
  /** Deny a pending approval nobody answered after this long (ms), so a run never waits forever.
   *  0 = wait for the operator. */
  approvalTimeoutMs: number;
}

export const DEFAULT_GOVERNOR_CFG: GovernorCfg = {
  outOfFolderWrites: "allow",
  approvalRemindMs: 30 * 60 * 1000,
  approvalTimeoutMs: 2 * 60 * 60 * 1000,
};

/** The project fence (ADR-0031): a dispatched or loop worker — and its helper agents, whose calls
 *  re-enter the same hook — writes only in its own project. `root` is the work root whose top-level
 *  folders are projects (/home); `allow` lists engine folders under it any worker may write
 *  (Neo's handoff notes). */
export interface ProjectFence {
  root: string;
  allow?: string[];
}

/** Per-session context the governor judges against (the worker's project folder = SDK cwd). */
export interface GovernorCtx {
  folder: string;
  /** Absent or anything but "allow" = "ask" (fails closed). */
  outOfFolderWrites?: OutOfFolderWrites;
  /** Set for dispatch and loop workers; absent = no cross-project check (operator sessions). */
  projectFence?: ProjectFence;
}

/** The OTHER project root `target` lies in (e.g. "/home/eticket-v3"), or undefined when it is in the
 *  session's own project, outside the work root, or in an allowed engine folder. */
export function foreignProject(target: string, folder: string, fence: ProjectFence): string | undefined {
  try {
    const root = resolve(fence.root);
    const t = realish(resolve(resolve(folder), target));
    if (!t.startsWith(root + sep)) return undefined;
    if ((fence.allow ?? []).some((a) => t === resolve(a) || t.startsWith(resolve(a) + sep))) return undefined;
    const top = (p: string) => p.slice(root.length + 1).split(sep)[0] ?? "";
    const own = realish(resolve(folder));
    if (own.startsWith(root + sep) && top(own) === top(t)) return undefined;
    const other = root + sep + top(t);
    // A sibling git worktree of the session's own repository is its own project.
    if (own.startsWith(root + sep) && worktreeOf(other, root + sep + top(own))) return undefined;
    return other;
  } catch {
    return undefined;
  }
}

/** `p` with symlinks resolved on its longest existing prefix (the rest may not exist yet), so a link
 *  inside the project that points at another project is judged where it really leads. */
function realish(p: string): string {
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

/** True when `dir` is a git worktree of the repository at `repo`: its `.git` FILE points into
 *  `<repo>/.git/worktrees/`. Pure file reads — no git process. */
function worktreeOf(dir: string, repo: string): boolean {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(dir, ".git"), "utf8"));
    return !!m && resolve(dir, m[1]!.trim()).startsWith(join(realish(repo), ".git", "worktrees") + sep);
  } catch {
    return false;
  }
}

const CROSS = (dir: string) =>
  `write into another project (${dir}). Stay in your own project; send work for another project back to Neo to dispatch there.`;

/** Git subcommands that change a repository (a branch, a commit, a worktree, the index or the tree). */
const GIT_WRITE = /^(commit|checkout|switch|branch|merge|rebase|reset|tag|stash|worktree|cherry-pick|revert|am|apply|add|rm|mv|restore|push|pull|init)$/;
/** Shell commands that write the file paths they are given. */
const WRITE_CMD = /^(cp|mv|tee|mkdir|touch|rm|rmdir|rsync|install|ln|truncate)$/;

/** The other project a shell command writes into, or undefined (ADR-0031). Defense in depth: it reads
 *  the usual shapes (git -C / cd + git, --git-dir/--work-tree, redirections, cp/mv/tee/mkdir/sed -i). */
function bashForeignWrite(command: string, folder: string, fence: ProjectFence, depth = 0): string | undefined {
  // Code run by a nested shell (`sh -c '…'`, `bash -c "…"`, `eval '…'`) is checked as a command of its
  // own, then removed so its quoted text is not read as words here.
  const NESTED = /\b(?:(?:ba|z|da)?sh\s+(?:-\w+\s+)*-c|eval)\s+("(?:[^"\\]|\\.)*"|'[^']*')/g;
  if (depth < 3) {
    for (const m of command.matchAll(NESTED)) {
      const hit = bashForeignWrite(m[1]!.slice(1, -1), folder, fence, depth + 1);
      if (hit) return hit;
    }
  }
  const home = homedir();
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home);
  let cwd = folder;
  for (const statement of command.replace(NESTED, " ").split(/&&|\|\||[;\n]/)) {
    for (const raw of statement.split("|")) {
      const seg = raw.trim().replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "");
      let words = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((w) => expand(w.replace(/["']/g, ""))) ?? [];
      // Leading VAR=value words; GIT_DIR / GIT_WORK_TREE name the repository git will write.
      let gitRepo: string | undefined;
      while (words.length && /^\w+=/.test(words[0]!)) {
        const [k, ...v] = words[0]!.split("=");
        if (k === "GIT_DIR" || k === "GIT_WORK_TREE") gitRepo = v.join("=").replace(/\/\.git$/, "");
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
      // Resolved against the shell's current folder, judged against the SESSION's own project.
      const at = (p: string) => foreignProject(resolve(resolve(cwd), p), folder, fence);
      if ((words[0] === "cd" || words[0] === "pushd") && words[1]) {
        cwd = resolve(resolve(cwd), words[1]);
        continue;
      }
      // A redirection writes its target (`> file`, `>> file`, `2>file`); a `>` inside quotes is text.
      const unquoted = seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
      for (const m of unquoted.matchAll(/\d?>>?\s*(?!&)([^\s;&|]+)/g)) {
        const hit = at(expand(m[1]!));
        if (hit) return hit;
      }
      if (words[0] === "git") {
        let repo = gitRepo ? resolve(resolve(cwd), gitRepo) : cwd;
        let i = 1;
        for (; i < words.length && words[i]!.startsWith("-"); i++) {
          const w = words[i]!;
          if (w === "-C" && words[i + 1]) repo = resolve(resolve(cwd), words[++i]!);
          else if ((w === "--git-dir" || w === "--work-tree") && words[i + 1]) repo = resolve(resolve(cwd), words[++i]!.replace(/\/\.git$/, ""));
          else if (/^--(git-dir|work-tree)=/.test(w)) repo = resolve(resolve(cwd), w.slice(w.indexOf("=") + 1).replace(/\/\.git$/, ""));
          else if (w === "-c" || w === "--namespace") i++; // its value is not the subcommand
        }
        if (GIT_WRITE.test(words[i] ?? "")) {
          const hit = at(repo);
          if (hit) return hit;
        }
        continue;
      }
      const writes = WRITE_CMD.test(words[0]!) || (words[0] === "sed" && words.some((w) => w === "-i" || w.startsWith("-i")));
      if (!writes) continue;
      // `-t DIR` names the target; otherwise cp/mv/rsync/install/ln write their LAST argument and
      // the others write every path they name.
      const t = words.indexOf("-t");
      const paths = words.slice(1).filter((w, i, all) => !w.startsWith("-") && all[i - 1] !== "-t");
      const targets = t > 0 && words[t + 1] ? [words[t + 1]!] : /^(cp|mv|rsync|install|ln)$/.test(words[0]!) ? paths.slice(-1) : paths;
      for (const p of targets) {
        const hit = at(p);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

/** Risky bash patterns that must never auto-run — they escalate to Neo. Defense-in-depth
 *  only (a keyword regex is bypassable); the real guards are the path fence + default-escalate. */
export const RISKY_BASH =
  /\b(rm|deploy|git\s+push|force|curl|wget|sudo|prod(uction)?|drop\s+table|shutdown|reboot|chmod\s+-R|dd|mkfs|p?kill|npm\s+publish|gh\s+pr\s+merge|ssh|scp|truncate)\b|\bfind\b.*?\s-delete\b/is;

/** Tools that are always safe to auto-allow (read-only / local bookkeeping). `Task`/`Agent`
 *  are safe because subagent tool calls re-enter canUseTool and are governed individually. */
export const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "TodoWrite",
  "NotebookRead",
  "ListMcpResources",
  "WebSearch",
  "Task",
  "Agent",
]);

/** Tools that write files — allowed inside the session's project folder; outside it, per
 *  `outOfFolderWrites`. */
const FENCED_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/** True iff `filePath` (absolute or folder-relative) resolves inside `folder`. Fails closed. */
function insideFolder(filePath: string, folder: string): boolean {
  if (!filePath || !folder) return false;
  try {
    const base = resolve(folder);
    const target = resolve(base, filePath);
    return target === base || target.startsWith(base + sep);
  } catch {
    return false;
  }
}

export function decide(tool: string, input: Record<string, unknown>, ctx: GovernorCtx): Verdict {
  // The SDK's structured-question tool can't be serviced headlessly: its options never reach
  // the operator's channel and there's no path to feed an answer back. Deny it and steer the
  // worker to ask in plain text — the channel surfaces that and the reply returns as a follow-up.
  if (tool === "AskUserQuestion") {
    return {
      deny: "Neo has no structured-question UI. Ask the operator your question in plain text instead; their reply arrives as a normal follow-up message. Do not assume a default — wait for the answer.",
    };
  }

  if (SAFE_TOOLS.has(tool)) return { allow: true };

  // Neo's own in-process MCP tools (dispatch, ...). Foreign mcp__* falls to default-escalate.
  if (tool.startsWith("mcp__neo__")) return { allow: true };

  if (FENCED_TOOLS.has(tool)) {
    const raw = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
    const path = typeof raw === "string" ? raw : "";
    // Another project is never a plain write (ADR-0031): the operator decides. Checked first, so a
    // symlink inside the folder that leads to another project is judged where it really leads.
    const other = path && ctx.projectFence ? foreignProject(path, ctx.folder, ctx.projectFence) : undefined;
    if (other) return { escalate: CROSS(other), fenced: true };
    if (insideFolder(path, ctx.folder)) return { allow: true };
    // The operator's standing approval (ADR-0012). Still needs a path: an empty one writes nothing.
    if (path && ctx.outOfFolderWrites === "allow") return { allow: true };
    // A fence escalation: the operator may approve it, but trust never does (ADR-0011).
    return {
      escalate: `file write outside the project folder: ${path || "(no path)"} (folder: ${ctx.folder || "(unset)"})`,
      fenced: true,
    };
  }

  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const other = ctx.projectFence ? bashForeignWrite(command, ctx.folder, ctx.projectFence) : undefined;
    if (other) return { escalate: CROSS(other), fenced: true };
    if (RISKY_BASH.test(command)) return { escalate: `risky shell command: ${command}` };
    return { allow: true };
  }

  // Default: escalate. New/unknown SDK tools, WebFetch (exfiltration channel), foreign MCP.
  return { escalate: `unrecognized tool: ${tool}` };
}
