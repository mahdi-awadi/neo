import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKit, mergeHooks } from "../tools/security/install";

const KIT = "/home/x/.claude/security";

describe("security kit install", () => {
  test("merging adds the guard and post-edit hooks and keeps everything else", () => {
    const before = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }],
        Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
      },
    };
    const after = mergeHooks(before, KIT) as typeof before & { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>> };
    expect(after.model).toBe("opus");
    expect(after.hooks.Stop).toEqual(before.hooks.Stop);
    const pre = after.hooks.PreToolUse!;
    expect(pre[0]).toEqual(before.hooks.PreToolUse[0]!); // the operator's own hook stays first
    expect(pre[1]!.hooks[0]!.command).toBe(`bash ${KIT}/hooks/guard.sh`);
    expect(pre[1]!.matcher).toContain("Read");
    const post = after.hooks.PostToolUse!;
    expect(post).toHaveLength(1);
    expect(post[0]!.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(post[0]!.hooks[0]).toMatchObject({ command: `bash ${KIT}/hooks/post-edit.sh`, timeout: 90 });
    expect(before.hooks.PreToolUse).toHaveLength(1); // input not mutated
  });

  test("merging twice changes nothing; a moved kit replaces our entries instead of adding more", () => {
    const once = mergeHooks({}, KIT);
    expect(mergeHooks(once, KIT)).toEqual(once);
    const moved = mergeHooks(once, "/opt/kit") as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(moved.hooks.PreToolUse).toHaveLength(1);
    expect(moved.hooks.PreToolUse![0]!.hooks[0]!.command).toBe("bash /opt/kit/hooks/guard.sh");
  });

  test("a user's own hooks/guard.sh is not mistaken for ours", () => {
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "bash /home/me/hooks/guard.sh" }] };
    const after = mergeHooks({ hooks: { PreToolUse: [mine] } }, KIT) as { hooks: Record<string, unknown[]> };
    expect(after.hooks.PreToolUse).toHaveLength(2);
    expect(after.hooks.PreToolUse![0]).toEqual(mine);
  });

  test("install copies the kit, writes settings, and is idempotent; a broken settings file is never overwritten", () => {
    const home = mkdtempSync(join(tmpdir(), "neo-sec-home-"));
    const src = mkdtempSync(join(tmpdir(), "neo-sec-src-"));
    mkdirSync(join(src, "hooks"), { recursive: true });
    mkdirSync(join(src, "rules", "custom"), { recursive: true });
    writeFileSync(join(src, "hooks", "guard.sh"), "#!/bin/bash\n");
    writeFileSync(join(src, "rules", "custom", "a.yaml"), "rules: []\n");
    writeFileSync(join(src, "WIP.md"), "notes");
    writeFileSync(join(src, "security-scan.md"), "# scan\n");
    const claude = join(home, ".claude");
    mkdirSync(claude);
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ theme: "dark" }));

    const r1 = installKit({ src, claudeDir: claude });
    expect(r1.dest).toBe(join(claude, "security"));
    expect(existsSync(join(claude, "security", "hooks", "guard.sh"))).toBe(true);
    expect(existsSync(join(claude, "security", "rules", "custom", "a.yaml"))).toBe(true);
    expect(existsSync(join(claude, "security", "WIP.md"))).toBe(false); // build notes are not installed
    expect(readFileSync(join(claude, "commands", "security-scan.md"), "utf8")).toBe("# scan\n");
    expect(existsSync(join(claude, "commands", "security-review.md"))).toBe(false); // never shadows the built-in
    const s1 = readFileSync(join(claude, "settings.json"), "utf8");
    expect(JSON.parse(s1).theme).toBe("dark");
    expect(s1).toContain(`bash ${join(claude, "security")}/hooks/guard.sh`);
    expect(r1.settingsChanged).toBe(true);

    const r2 = installKit({ src, claudeDir: claude });
    expect(r2.settingsChanged).toBe(false);
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(s1);

    writeFileSync(join(claude, "settings.json"), "{ not json");
    expect(() => installKit({ src, claudeDir: claude })).toThrow(/settings\.json/);
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe("{ not json");
  });

  // ADR-0039: the host environment lives in the installed kit; no flag keeps what is there.
  test("--host-env writes host.json; a re-install without it keeps the file; a bad value is refused", () => {
    const src = mkdtempSync(join(tmpdir(), "neo-sec-src-"));
    const claude = mkdtempSync(join(tmpdir(), "neo-sec-claude-"));
    const host = join(claude, "security", "host.json");
    installKit({ src, claudeDir: claude });
    expect(existsSync(host)).toBe(false); // never set: the guard reads that as prod
    expect(installKit({ src, claudeDir: claude, hostEnv: "dev" }).hostEnv).toBe("dev");
    expect(JSON.parse(readFileSync(host, "utf8"))).toEqual({ hostEnv: "dev" });
    expect(installKit({ src, claudeDir: claude }).hostEnv).toBe("dev"); // kept
    expect(JSON.parse(readFileSync(host, "utf8"))).toEqual({ hostEnv: "dev" });
    installKit({ src, claudeDir: claude, hostEnv: "prod" });
    expect(JSON.parse(readFileSync(host, "utf8"))).toEqual({ hostEnv: "prod" });
    expect(() => installKit({ src, claudeDir: claude, hostEnv: "staging" as never })).toThrow(/host-env/);
  });
});
