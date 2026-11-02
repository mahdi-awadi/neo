// A note must never carry a secret (ADR-0043). Fixtures are assembled at runtime so the repo's own
// secret scanners do not read this file as a leak.
import { expect, test } from "bun:test";
import { findSecret } from "../src/engine/secret-patterns";

const r = (s: string, n: number) => s.repeat(n);
const HITS: Array<[string, string]> = [
  ["private_key", `-----BEGIN ${"RSA PRIVATE"} KEY-----\nMIIE...`],
  ["private_key", `-----BEGIN ${"OPENSSH PRIVATE"} KEY-----`],
  ["aws_access_key", `key ${"AK" + "IA"}${r("Q", 16)} here`],
  ["github_token", `${"gh" + "p_"}${r("a1", 18)}`],
  ["github_token", `${"github" + "_pat_"}${r("A1_", 10)}`],
  ["gitlab_token", `${"glp" + "at-"}${r("x1", 11)}`],
  ["slack_token", `${"xo" + "xb-"}123456789012-${r("a", 12)}`],
  ["stripe_key", `${"sk" + "_live_"}${r("Z9", 10)}`],
  ["anthropic_key", `${"sk-" + "ant-"}api03-${r("Ab", 15)}`],
  ["openai_key", `${"sk-" + "proj-"}${r("Ab1", 10)}`],
  ["google_api_key", `${"AI" + "za"}${r("B", 35)}`],
  ["jwt", `${"ey" + "J"}${r("h", 12)}.${"ey" + "J"}${r("p", 12)}.${r("s", 16)}`],
  ["url_credentials", `postgres://app:${"hunter" + "2pass"}@db:5432/x`],
  ["assignment", `DB_PASSWORD=${"s3cr3t" + "Value9"}`],
  ["assignment", `"api_key": "${"live" + "Key12345"}"`],
];

for (const [name, text] of HITS) {
  test(`finds ${name}: ${name === "private_key" ? "PEM block" : "a real-looking value"}`, () => {
    expect(findSecret(text)).toBe(name);
  });
}

test("placeholders and plain prose are not secrets", () => {
  for (const t of [
    "the password field must be at least 12 characters",
    "DB_PASSWORD=<your password>",
    "API_KEY=${API_KEY}",
    "token: xxxxxxxx",
    "secret = changeme",
    "password: ********",
    "postgres://app:${DB_PASS}@db:5432/x",
    "set the api_key in .env (see .env.example)",
    "D16: booking ref BK-2026-0042 has a stale provider_pnr",
    "commit 4f2a9c1 fixed it",
  ]) {
    expect(findSecret(t)).toBeUndefined();
  }
});

test("the answer names the pattern, never the matched text", () => {
  const value = "s3cr3t" + "Value9";
  const hit = findSecret(`PASSWORD=${value}`);
  expect(hit).toBe("assignment");
  expect(hit).not.toContain(value);
});
