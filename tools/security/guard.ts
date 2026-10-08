// Claude Code PreToolUse guard (ADR-0024): keep agents away from secret files (.env*, private keys,
// credential stores). A Neo worker (NEO_WORKER, or the CLI's session-state env the engine sets) is
// BLOCKED (exit 2); the operator's own interactive session is WARNED. Templates (.env.example and
// other *.example/.sample/.template/.dist/.defaults files) are always allowed.
//
// It looks at the paths a call names, never at free text: a Bash call's path tokens (commit
// messages, `--env-file` arguments and writes into ignore files are not "touching" a secret).
//
//   hooks/guard.sh → bun guard.ts  (the hook's JSON on stdin)
import { basename } from "node:path";

const TEMPLATE = /\.(example|sample|template|dist|defaults)$/i;
const KEY_EXT = /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i;
const SSH_KEY = /^id_(rsa|ed25519|ecdsa|dsa)$/;
const CRED_FILE = /^(\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials|credentials\.json|\.git-credentials|service-account[^/]*\.json)$/;

/** A path or glob names a secret file (judged by its last segment; a `*` may stand for the rest). */
export function isSecretName(token: string): boolean {
  if (/(^|\/)\.docker\/config\.json$/.test(token)) return true;
  const name = basename(token);
  if (!name || TEMPLATE.test(name)) return false;
  const bare = name.replace(/^\*+/, "").replace(/\*+$/, ""); // `.env*`, `*.pem`
  if (/^\.env(\.[\w.-]+)?$/.test(bare) || (name.endsWith("*") && bare.startsWith(".env"))) return true;
  return KEY_EXT.test(bare) || SSH_KEY.test(bare) || CRED_FILE.test(bare);
}

/** Bash: the path-like tokens of each command segment, minus what only names a secret file. */
function bashTokens(command: string): string[] {
  const cleaned = command
    .replace(/--env-file[ =]\S+/g, " ") // the file is used by docker, not read into context
    .replace(/(?:-m|--message)(?:\s+|=)("(?:[^"\\]|\\.)*"|'[^']*')/g, " "); // a commit message is text
  return cleaned
    .split(/&&|\|\||[;|\n]/)
    .filter((seg) => !/>>?\s*\S*\.(git|docker|npm|prettier|eslint)ignore\b/.test(seg)) // listing it in an ignore file
    .flatMap((seg) => seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
    .map((t) => t.replace(/["']/g, "").replace(/^\d?[<>]+/, ""));
}

/** The secret files a tool call touches, by name, in order. */
export function secretTargets(tool: string, input: Record<string, unknown>): string[] {
  const str = (k: string) => (typeof input[k] === "string" ? [input[k] as string] : []);
  const tokens =
    tool === "Bash"
      ? bashTokens(String(input.command ?? ""))
      : tool === "Grep"
        ? [...str("path"), ...str("glob")] // its `pattern` is the text searched for, not a path
        : [...str("file_path"), ...str("notebook_path"), ...str("path"), ...(tool === "Glob" ? str("pattern") : [])];
  // Named by the last segment; a folder-spanning glob (`**/*.pem`) is shown whole.
  return tokens.filter(isSecretName).map((t) => (t.startsWith("**/") ? t : basename(t)));
}

if (import.meta.main) {
  let call: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    call = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0); // not a hook payload: nothing to guard
  }
  const hits = secretTargets(String(call.tool_name ?? ""), call.tool_input ?? {});
  if (!hits.length) process.exit(0);
  const worker = Boolean(process.env.NEO_WORKER || process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS);
  if (worker) {
    console.error(
      `Blocked by security guard: ${call.tool_name} on a secret file (${hits.join(", ")}). Secrets stay out of agent context. ` +
        "Read config via the app's env loader, or ask the operator (ask_operator) to set or check the value.",
    );
    process.exit(2);
  }
  console.error(`[security] warning: ${call.tool_name} touches a secret file (${hits.join(", ")}) — never paste its values into code, logs or replies.`);
  process.exit(0);
}
