import { describe, expect, test } from "bun:test";
import { secretTargets } from "../tools/security/guard";

const bash = (command: string) => secretTargets("Bash", { command });

describe("security guard: which secret files a tool call touches", () => {
  test("file tools: secret files are caught, templates are not", () => {
    expect(secretTargets("Read", { file_path: "/srv/app/.env" })).toEqual([".env"]);
    expect(secretTargets("Read", { file_path: "/srv/app/.env.production" })).toEqual([".env.production"]);
    expect(secretTargets("Edit", { file_path: "/srv/app/certs/server.key" })).toEqual(["server.key"]);
    expect(secretTargets("Read", { file_path: "/home/u/.ssh/id_ed25519" })).toEqual(["id_ed25519"]);
    expect(secretTargets("Read", { file_path: "/srv/app/.env.example" })).toEqual([]);
    expect(secretTargets("Read", { file_path: "/srv/app/src/env.ts" })).toEqual([]);
    expect(secretTargets("Read", { file_path: "/srv/app/docs/keyboard.md" })).toEqual([]);
  });

  test("Grep and Glob: the path, pattern and glob are checked, wildcards included", () => {
    expect(secretTargets("Grep", { pattern: "KEY", glob: ".env*" })).toEqual([".env*"]);
    expect(secretTargets("Grep", { pattern: "KEY", path: "/srv/app/.env" })).toEqual([".env"]);
    expect(secretTargets("Glob", { pattern: "**/*.pem" })).toEqual(["**/*.pem"]);
    expect(secretTargets("Grep", { pattern: "dotenv", path: "/srv/app/src" })).toEqual([]);
  });

  test("Bash: every path token is checked; a template next to a secret does not unlock it", () => {
    expect(bash("cat .env")).toEqual([".env"]);
    expect(bash("cp .env.example .env && cat .env")).toEqual([".env", ".env"]);
    expect(bash("grep -r KEY .env*")).toEqual([".env*"]);
    expect(bash("cat ~/.git-credentials")).toEqual([".git-credentials"]);
    expect(bash("cat ./config/'service-account-prod.json'")).toEqual(["service-account-prod.json"]);
  });

  test("Bash: naming a secret file is not touching it", () => {
    expect(bash("echo .env >> .gitignore")).toEqual([]);
    expect(bash('printf "%s\\n" .env.local >> .dockerignore')).toEqual([]);
    expect(bash('git commit -m "rotate credentials handling for .env"')).toEqual([]);
    expect(bash("git commit -m 'drop id_rsa support'")).toEqual([]);
    expect(bash("docker compose --env-file .env.prod up -d")).toEqual([]);
    expect(bash("cp .env.example .env.local.example")).toEqual([]);
    expect(bash("ls src && bun test")).toEqual([]);
  });
});
