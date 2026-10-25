// ADR-0050 rev. 2 guard: the rev. 1 agent-messaging design (own table, ask_agent/tell_agent tools,
// post hook) was replaced by project notes. It must not come back as a second mechanism.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SELF = resolve(import.meta.path);
const BANNED = ["ask_agent", "tell_agent", "agent_messages", "agentPost", "agent-post"];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx|js|json|sql|html|css)$/.test(name)) yield p;
  }
}

test("src/ and tests/ never mention the replaced agent-messaging mechanism", () => {
  const hits: string[] = [];
  for (const dir of ["src", "tests"]) {
    for (const f of files(join(ROOT, dir))) {
      if (resolve(f) === SELF) continue;
      const text = readFileSync(f, "utf8");
      for (const word of BANNED) if (text.includes(word)) hits.push(`${f}: ${word}`);
    }
  }
  expect(hits).toEqual([]);
});

test("ADR-0043 records that ADR-0050 amended it", () => {
  const dir = join(ROOT, "docs/adr");
  const name = readdirSync(dir).find((n) => n.startsWith("0043-"))!;
  const status = readFileSync(join(dir, name), "utf8").split("\n").find((l) => l.startsWith("**Status:**"))!;
  expect(status).toContain("Amended by ADR-0050");
});
