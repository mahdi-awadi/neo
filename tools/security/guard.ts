// Claude Code PreToolUse guard (ADR-0024, ADR-0030): keep agents away from secret files (.env*,
// private keys, credential stores). A Neo worker (NEO_WORKER, or the CLI's session-state env the
// engine sets) is BLOCKED (exit 2); the operator's own interactive session is WARNED. Templates
// (.env.example and other *.example/.sample/.template/.dist/.defaults files) are always allowed.
//
// It looks for READS of secret files, never at free text (ADR-0030): in a Bash call, code (`node -e`,
// `python -c`), search patterns (grep/rg/sed/awk/`git log -S`), commit messages and commands that only
// LIST names (ls, find without -exec, git ls-files/status) are not reads. A bare key-file name with
// no path (`server.key`) counts only when that file exists, so `e.key` in a snippet is just text.
//
// On a `dev` host (host.json next to this file, ADR-0039) a WRITE to a secret file is allowed: the
// Write tool, output redirections, `sed -i` and a `cp` destination. Reads stay blocked on every host.
// A missing or unreadable host.json means `prod`, where nothing changed.
//
//   hooks/guard.sh → bun guard.ts  (the hook's JSON on stdin)
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type HostEnv = "dev" | "prod";

/** The host environment set in `file` (ADR-0039). Anything but an explicit `"dev"` is `prod`. */
export function hostEnvAt(file: string): HostEnv {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { hostEnv?: unknown }).hostEnv === "dev" ? "dev" : "prod";
  } catch {
    return "prod"; // missing or unreadable: fail closed
  }
}

const TEMPLATE = /\.(example|sample|template|dist|defaults)$/i;
const KEY_EXT = /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i;
const SSH_KEY = /^id_(rsa|ed25519|ecdsa|dsa)$/;
/** The files in a `.ssh` folder that are NOT private keys (reach plan P0.3: every other file there is). */
const SSH_PUBLIC = /^(known_hosts2?(\.old)?|config|authorized_keys2?|authorized_principals|allowed_signers|.*\.pub|environment|rc)$/;
/** A file directly inside a `.ssh` folder that is not one of its public files: a private key, whatever its name. */
const inSshFolder = (token: string) => /(^|\/)\.ssh\/[^/]+$/.test(token) && !SSH_PUBLIC.test(basename(token));
const CRED_FILE = /^(\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials|credentials\.json|\.git-credentials|service-account[^/]*\.json)$/;

const bareName = (token: string) => basename(token).replace(/^\*+/, "").replace(/\*+$/, ""); // `.env*`, `*.pem`

/** A name that is a secret on its own, wherever it appears: .env*, an SSH key, a credential store. */
function isStrongSecret(token: string): boolean {
  if (/(^|\/)\.docker\/config\.json$/.test(token)) return true;
  if (inSshFolder(token)) return true;
  const name = basename(token);
  if (!name || TEMPLATE.test(name)) return false;
  const bare = bareName(token);
  return /^\.env(\.[\w.-]+)?$/.test(bare) || (name.endsWith("*") && bare.startsWith(".env")) || SSH_KEY.test(bare) || CRED_FILE.test(bare);
}

/** A path or glob names a secret file (judged by its last segment; a `*` may stand for the rest). */
export function isSecretName(token: string): boolean {
  const name = basename(token);
  if (!name || TEMPLATE.test(name)) return false;
  return isStrongSecret(token) || KEY_EXT.test(bareName(token));
}

/** Shell words of a command segment, quote-aware (quotes removed; a quoted phrase stays one word). */
const words = (seg: string): string[] =>
  (seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((t) => t.replace(/["']/g, "").replace(/^\d?[<>]+/, "")).filter(Boolean);

/** Commands that only list, stat or move names — they never put a file's content in context. */
const LISTING = new Set(["ls", "stat", "file", "du", "test", "[", "realpath", "readlink", "dirname", "basename", "chmod", "chown", "touch", "mkdir", "rm", "wc", "echo", "printf"]);
const GIT_LISTING = new Set(["ls-files", "status", "check-ignore", "add", "rm", "mv", "restore", "stash", "checkout", "switch", "branch", "commit", "push", "pull", "fetch"]);
/** Search tools: their first positional argument (or every -e argument) is a pattern, not a file. */
const SEARCH = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
/** Script tools: their first positional argument (or every -e argument) is a program, not a file. */
const SCRIPT = new Set(["sed", "awk", "gawk", "jq"]);
/** Interpreters: the argument after -e/-c/--eval is code (and after -p for the JS runtimes only — in
 *  perl and ruby, -p is a flag and the next word is a FILE). */
const INTERPRETER = new Set(["node", "bun", "deno", "python", "python3", "ruby", "perl", "php"]);
const JS_RUNTIME = new Set(["node", "bun", "deno"]);
/** Commands that put a named file's content in context or move it on: a bare key name they are given
 *  counts whether or not it exists where we look (ADR-0030). */
const READERS = new Set(["cat", "less", "more", "head", "tail", "bat", "nl", "od", "xxd", "hexdump", "strings", "cp", "scp", "rsync", "base64", "openssl", "sort", "uniq", "tac", "rev", "diff", "cmp", "source", ".", "dd", "curl", "tar", "zip", "gpg", "cut", "paste", "tee"]);
/** Options that take a value (so the value is not the positional pattern). */
const VALUE_OPTS = new Set(["-A", "-B", "-C", "-m", "-M", "-t", "-T", "--max-count", "--type", "--context", "--after-context", "--before-context"]);
/** Options whose value is a file glob the tool will READ (checked like a path). */
const GLOB_OPTS = new Set(["-g", "--glob", "--include"]);

/** The argument words of one command that can name a file it reads, with patterns, code and
 *  name-only listings removed, and whether the command is a known reader. `feeds`: this stage pipes
 *  names into xargs / while-read, so a listing is a read after all. */
function readCandidates(seg: string, feeds: boolean, writes: boolean): { args: string[]; reader: boolean } {
  let w = words(seg);
  for (;;) {
    if (w.length && (/^\w+=/.test(w[0]!) || ["sudo", "env", "time", "nohup", "command", "exec"].includes(w[0]!))) w = w.slice(1);
    else if (w[0] === "xargs") {
      w = w.slice(1);
      while (w.length && w[0]!.startsWith("-")) w = /^-(I|n|P|L|d|E|s)$/.test(w[0]!) ? w.slice(2) : w.slice(1); // its options
    } else break;
  }
  const cmd = basename(w[0] ?? "");
  const reader = READERS.has(cmd);
  if (feeds && (LISTING.has(cmd) || cmd === "find")) return { args: w.slice(1), reader }; // names piped on to a reader
  return { args: candidateArgs(cmd, w.slice(1), writes), reader };
}

/** The one sed program shape that only rewrites a file in place: an optional address, then `d` or a
 *  single `s` with flags g/I/digits. No `w`/`e`/`r`/`p`, no `;` (they copy, run or print lines). */
const SAFE_SED_PROGRAM = /^(?:\d+|\$|\/(?:\\.|[^/\\])*\/)?(?:d|s(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gI\d]*)$/;
const SAFE_SED_OPTION = /^(-[Er]*i[Er]*(\.[\w.]+)?|-[Er]+|--in-place(=[\w.]+)?|--regexp-extended)$/;

/** `sed -i` that can only rewrite its files: in-place, safe options, and every program a safe one. */
function isInPlaceSed(args: string[]): boolean {
  if (!args.some((a) => /^-[Er]*i/.test(a) || a.startsWith("--in-place"))) return false;
  const programs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-e" || a === "--expression") programs.push(args[++i] ?? "");
    else if (a.startsWith("-") && !SAFE_SED_OPTION.test(a)) return false; // --debug, -f FILE, -n, -s …
  }
  if (!programs.length) programs.push(args.find((a) => !a.startsWith("-")) ?? "");
  return programs.every((p) => SAFE_SED_PROGRAM.test(p));
}

/** `writes` (a dev host, ADR-0039): an in-place sed and a cp destination are writes, not reads. */
function candidateArgs(cmd: string, args: string[], writes = false): string[] {
  if (writes && cmd === "sed" && isInPlaceSed(args)) return [];
  if (writes && cmd === "cp" && !args.some((a) => /^-[^-]*t|^--t/.test(a))) {
    const dest = args.findLastIndex((a) => !a.startsWith("-")); // with -t (or any `--t…` abbreviation of --target-directory) the last word is a source
    args = args.filter((_, i) => i !== dest);
  }
  if (cmd === "git") {
    const at = args.findIndex((a) => !a.startsWith("-"));
    const sub = at >= 0 ? args[at]! : "";
    args = args.slice(at + 1);
    if (GIT_LISTING.has(sub)) return [];
    if (sub === "log" && !args.some((a) => a === "-p" || a === "--patch")) return [];
    if (sub === "grep") return searchArgs(args);
    // git log -p / show / diff / blame read content: drop -S/-G/--grep search strings, check the rest
    return args.filter((a, i) => !/^(-[SG]|--grep)$/.test(args[i - 1] ?? "") && !/^-[SG].|^--grep=/.test(a));
  }
  if (LISTING.has(cmd)) return [];
  if (cmd === "find") return args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)) ? args : [];
  if (SEARCH.has(cmd)) return searchArgs(args);
  if (SCRIPT.has(cmd)) return programArgs(args);
  const interp = INTERPRETER.has(cmd) ? cmd : cmd.replace(/[\d.]+$/, "");
  if (INTERPRETER.has(interp)) {
    const code = JS_RUNTIME.has(interp) ? /^(-e|-p|--eval|--print)$/ : /^(-e|-c|--eval)$/;
    return args.filter((_, i) => !code.test(args[i - 1] ?? ""));
  }
  return args;
}

/** grep/rg/…: everything except the pattern (the first positional, or every -e value); -f and
 *  --include/-g values are files it reads. */
function searchArgs(args: string[]): string[] {
  const out: string[] = [];
  let patternTaken = args.some((a) => a === "-e" || a === "--regexp" || a.startsWith("--regexp=") || a === "-f" || a === "--file");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-e" || a === "--regexp") {
      i++; // the pattern
      continue;
    }
    if (a === "-f" || a === "--file" || GLOB_OPTS.has(a)) {
      if (args[i + 1] !== undefined) out.push(args[i + 1]!);
      i++;
      continue;
    }
    if (VALUE_OPTS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      if (eq > 0 && GLOB_OPTS.has(a.slice(0, eq))) out.push(a.slice(eq + 1));
      continue;
    }
    if (!patternTaken) {
      patternTaken = true; // the positional pattern
      continue;
    }
    out.push(a);
  }
  return out;
}

/** sed/awk/jq: everything except the program (the first positional, or every -e value). */
function programArgs(args: string[]): string[] {
  const out: string[] = [];
  let programTaken = args.some((a) => a === "-e" || a === "--expression" || a === "-f");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-e" || a === "--expression") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (!programTaken) {
      programTaken = true;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** A word that is a path to a secret file (as shown in the message), or undefined. Code and regex
 *  words are not paths; a bare key-file name counts only when it exists under `cwd`. */
function secretPath(word: string, cwd: string, reader = false): string | undefined {
  const home = homedir();
  let t = word.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home);
  if (/^--?[\w-]+=/.test(t) || /^[a-z]+=/.test(t)) t = t.slice(t.indexOf("=") + 1); // --file=x, dd if=x
  t = t.replace(/^@/, ""); // curl --data-binary @file
  const probe = t.replace(/\$\{?\w+\}?/g, "V");
  if (/[()[\]{}<>|;&!`\\]/.test(probe)) return undefined; // code or a regex
  if (/\s/.test(probe) && !probe.includes("/")) return undefined; // a phrase, not a path (a quoted "dir name/file" is one)
  if (!t.startsWith("/") && /^[^/]*:/.test(t)) t = t.slice(t.indexOf(":") + 1); // HEAD:config/server.key
  if (!isSecretName(t)) return undefined;
  const shown = t.startsWith("**/") ? t : basename(t);
  if (isStrongSecret(t)) return shown;
  // A key-file extension: a path, a glob or a variable is meant as a file; a bare word must exist.
  if (reader || t.includes("/") || /[*?$]/.test(t)) return shown;
  return existsSync(resolve(cwd, t)) ? shown : undefined;
}

/** Input redirections (`< file`, `3<file`) read their file, whatever the command. Not `<<`, `<&` or `<(`. */
const INPUT_REDIRECT = /(?:^|[^<\d&])\d?<\s*(?![<&(])([^\s<>&|;()]+)/g;
/** Output redirections (`> f`, `>> f`, `2> f`, `&> f`) write their file. Not `>&2` or `>(…)`. A
 *  quoted string is matched first and kept, so a `>` inside quotes (`grep -v '> ' .env`) is text. */
const OUTPUT_REDIRECT = /"[^"]*"|'[^']*'|(?<![<>&\d])(?:\d|&)?>>?\|?\s*(?![&>(])(?:"[^"]*"|'[^']*'|[^\s<>&|;()"'])+/g;
const stripOutputRedirects = (stage: string) => stage.replace(OUTPUT_REDIRECT, (m) => (m[0] === '"' || m[0] === "'" ? m : " "));

/** Bash: the secret files a command reads. Follows `cd`/`pushd` between statements, so a bare
 *  name is looked up where the command really is. */
function bashTargets(command: string, cwd: string, writes: boolean): string[] {
  const cleaned = command
    .replace(/--env-file[ =]\S+/g, " ") // the file is used by docker, not read into context
    .replace(/(?:-m|--message)(?:\s+|=)("(?:[^"\\]|\\.)*"|'[^']*')/g, " "); // a commit message is text
  const hits: string[] = [];
  let here = cwd;
  for (const statement of cleaned.split(/&&|\|\||[;\n]/)) {
    if (/>>?\s*\S*\.(git|docker|npm|prettier|eslint)ignore\b/.test(statement)) continue; // listing it in an ignore file
    const stages = statement.split("|").map((st) => st.trim().replace(/^[({]\s*/, "").replace(/\s*[)}]$/, ""));
    const first = words(stages[0] ?? "");
    if ((first[0] === "cd" || first[0] === "pushd") && first[1]) {
      here = resolve(here, first[1].replace(/^~(?=\/|$)/, homedir()));
      continue;
    }
    stages.forEach((stage, i) => {
      if (writes) stage = stripOutputRedirects(stage);
      for (const m of stage.matchAll(INPUT_REDIRECT)) {
        const hit = secretPath(m[1]!, here, true);
        if (hit) hits.push(hit);
      }
      const feeds = stages.slice(i + 1).some((later) => /^(xargs\b|while\s+read\b)/.test(later));
      const { args, reader } = readCandidates(stage.replace(INPUT_REDIRECT, " "), feeds, writes);
      for (const w of args) {
        const hit = secretPath(w, here, reader);
        if (hit) hits.push(hit);
      }
    });
  }
  return hits;
}

/** The secret files a tool call reads, by name, in order. `cwd`: where a bare file name resolves.
 *  `hostEnv` (default `prod`): on `dev`, writes to a secret file are not counted (ADR-0039). */
export function secretTargets(tool: string, input: Record<string, unknown>, ctx: { cwd?: string; hostEnv?: HostEnv } = {}): string[] {
  const writes = ctx.hostEnv === "dev";
  if (tool === "Bash") return bashTargets(String(input.command ?? ""), ctx.cwd ?? process.cwd(), writes);
  if (tool === "Glob") return []; // it lists names; it never reads a file
  if (tool === "Write" && writes) return []; // it creates or replaces a file and echoes nothing back
  const str = (k: string) => (typeof input[k] === "string" ? [input[k] as string] : []);
  const tokens = tool === "Grep" ? [...str("path"), ...str("glob")] : [...str("file_path"), ...str("notebook_path"), ...str("path")];
  // Named by the last segment; a folder-spanning glob (`**/*.pem`) is shown whole.
  return tokens.filter(isSecretName).map((t) => (t.startsWith("**/") ? t : basename(t)));
}

if (import.meta.main) {
  let call: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
  try {
    call = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0); // not a hook payload: nothing to guard
  }
  const hostEnv = hostEnvAt(join(import.meta.dir, "host.json"));
  const hits = secretTargets(String(call.tool_name ?? ""), call.tool_input ?? {}, { cwd: typeof call.cwd === "string" ? call.cwd : undefined, hostEnv });
  if (!hits.length) process.exit(0);
  const worker = Boolean(process.env.NEO_WORKER || process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS);
  if (worker) {
    console.error(
      `Blocked by security guard: ${call.tool_name} reads a secret file (${hits.join(", ")}). Secrets stay out of agent context. ` +
        "Read config via the app's env loader, or ask the operator (ask_operator) to set or check the value." +
        (hostEnv === "dev" ? " On this dev host you may WRITE a secret file (Write tool, `printf 'K=V\\n' >> .env`, `sed -i`), never read it." : ""),
    );
    process.exit(2);
  }
  console.error(`[security] warning: ${call.tool_name} reads a secret file (${hits.join(", ")}) — never paste its values into code, logs or replies.`);
  process.exit(0);
}
