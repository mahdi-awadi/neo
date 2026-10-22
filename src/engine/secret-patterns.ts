/** Known secret shapes in free text (ADR-0043): a project note is refused when its title, body, refs or
 *  reason match one. High-confidence shapes only (fixed token prefixes, PEM blocks, JWTs, credentials
 *  in a URL, a `password = value` assignment with a real-looking value), so plain prose and
 *  placeholders pass. The answer is the pattern's name, never the matched text. Plain code, no AI. */

const PATTERNS: Array<[name: string, re: RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ["gitlab_token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["stripe_key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/** `scheme://user:password@host` — the password part is checked against the placeholders. */
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi;

/** `password = value`, `"api_key": "value"`, `TOKEN: value` — the value is checked. */
const ASSIGNMENT =
  /\b[A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?([^\s"',;]+)/gi;

/** A value that stands for a secret instead of being one. */
const PLACEHOLDER = /^(?:<[^>]*>?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|x+|\*+|\.+|changeme|redacted|example|placeholder|none|null|empty|your[_-]?\S*)$/i;

const realValue = (v: string | undefined): boolean => !!v && v.length >= 6 && !PLACEHOLDER.test(v);

/** The name of the first secret pattern `text` matches; undefined when none does. */
export function findSecret(text: string): string | undefined {
  for (const [name, re] of PATTERNS) if (re.test(text)) return name;
  for (const m of text.matchAll(URL_CREDENTIALS)) if (realValue(m[1])) return "url_credentials";
  for (const m of text.matchAll(ASSIGNMENT)) if (realValue(m[1])) return "assignment";
  return undefined;
}
