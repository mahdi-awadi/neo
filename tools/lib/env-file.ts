// Env-file helpers for the Docker service kits (tools/browser, tools/history): parse KEY=value settings
// files, pick a setting across layers (tracked file, then the machine-local overrides), and add a generated
// secret to a `.env` file once. Nothing here prints or returns a secret value.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** KEY=value lines (comments and blanks skipped; no shell expansion). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

/** The value of `key` from env layers, later layers winning; a value `parse` rejects keeps the earlier one
 *  (fails closed to the tracked setting). */
export function pickSetting<T>(layers: Array<Record<string, string>>, key: string, parse: (v: string | undefined) => T | undefined): T | undefined {
  let v: T | undefined;
  for (const l of layers) v = parse(l[key]) ?? v;
  return v;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Make sure `file` defines `name` with a non-empty value: keep an existing value, else drop any empty
 *  definition and append `name=<generate()>`. The other lines stay as they are. The file ends with mode
 *  0600 (written through a 0600 temp file and a rename, so it is never readable by others). Returns only
 *  whether a key was added, never the value. */
export function ensureEnvKey(file: string, name: string, generate: () => string): { added: boolean } {
  if (!ENV_NAME.test(name)) throw new Error(`not an environment variable name: ${JSON.stringify(name)}`);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (parseEnvFile(text)[name]) {
    chmodSync(file, 0o600);
    return { added: false };
  }
  const value = generate();
  if (!value || /[\s"'#]/.test(value)) throw new Error("the generated key must be one plain token");
  const empty = new RegExp(`^\\s*${name}\\s*=\\s*["']?["']?\\s*$`);
  const kept = text.split("\n").filter((l) => !empty.test(l)).join("\n");
  const body = `${kept}${kept && !kept.endsWith("\n") ? "\n" : ""}${name}=${value}\n`;
  const tmp = `${file}.neo-${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return { added: true };
}
