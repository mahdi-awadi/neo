// The shared shell reader (bash-walk.ts): the governor's push rule (ADR-0069), the project fence (ADR-0031)
// and the side lanes (ADR-0057) all read commands through it. Quote- and heredoc-aware since ADR-0069.
import { test, expect } from "bun:test";
import { splitCommands, walkBash, gitCall } from "../src/engine/bash-walk";

const subs = (command: string) => {
  const out: string[] = [];
  walkBash(command, "/p", (seg) => {
    const g = gitCall(seg);
    if (g) out.push(g.sub);
    return undefined;
  });
  return out;
};

test("separators inside quotes are text, not command boundaries", () => {
  expect(splitCommands(`git commit -m "fix; git push later"`)).toEqual([`git commit -m "fix; git push later"`]);
  expect(splitCommands(`echo 'a && b | c' && ls`)).toEqual([`echo 'a && b | c'`, "ls"]);
  expect(splitCommands(`rg -n "git commit|git push" docs/`)).toEqual([`rg -n "git commit|git push" docs/`]);
  expect(splitCommands(`echo "say \\"x; y\\"" ; pwd`)).toEqual([`echo "say \\"x; y\\""`, "pwd"]);
});

test("a heredoc body is text; the command after its end marker is read", () => {
  const cmd = "cat > notes.md <<'EOF'\ngit push origin main\nrm -rf /\nEOF\ngit status";
  expect(splitCommands(cmd)).toEqual(["cat > notes.md <<'EOF'", "git status"]);
  expect(splitCommands("cat <<-END\n\tgit push\n\tEND\nls")).toEqual(["cat <<-END", "ls"]);
  expect(subs(`git commit -m "$(cat <<'EOF'\nfeat: x\n\ngit push later\nEOF\n)"`)).toEqual(["commit"]);
});

test("all separators split: ; newline && || | & (not the & of a redirection)", () => {
  expect(splitCommands("a; b\nc && d || e | f & g")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  expect(splitCommands("make 2>&1 | tee log &>/dev/null")).toEqual(["make 2>&1", "tee log &>/dev/null"]);
});

test("a backslash-newline continues the command", () => {
  expect(subs("git -C /home/x \\\n  push origin dev")).toEqual(["push"]);
});

test("compound-command keywords are not the command: the command after them is", () => {
  expect(subs(`for d in a b; do git -C "$d" push; done`)).toEqual(["push"]);
  expect(subs("if git diff --quiet; then git commit -m x; else git push; fi")).toEqual(["diff", "commit", "push"]);
  expect(subs("while true; do git fetch; done")).toEqual(["fetch"]);
  expect(subs("! git push")).toEqual(["push"]);
});

test("nested shells with combined flags, git by path, and env options are read", () => {
  expect(subs("bash -lc 'git push'")).toEqual(["push"]);
  expect(subs(`sh -ec "git push origin main"`)).toEqual(["push"]);
  expect(subs("/usr/bin/git push")).toEqual(["push"]);
  expect(subs("env -i PATH=/bin git push")).toEqual(["push"]);
  expect(subs("env -u HOME git push")).toEqual(["push"]);
});
