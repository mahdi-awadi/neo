// ADR-0059: every attention item explains itself — a kind badge, a plain title without raw prefixes, the
// facts its description is built from, its links, and exactly what → todo would send. Deterministic.
import { expect, test } from "bun:test";
import { explainAttention, plainPrTitle } from "../src/engine/attention-explain";
import type { AttentionRow } from "../src/engine/ledger";

const row = (over: Partial<AttentionRow>): AttentionRow => ({
  id: 1, project: "adminli", folder: "/home/adminli", source: "git", kind: "stale_branch", key: "k", title: "t", severity: "normal",
  firstSeen: 0, lastSeen: 0, dismissed: false, ...over,
});

test("#360: a Dependabot PR is a dependency update with a plain title and the PR link", () => {
  const e = explainAttention(row({ id: 360, source: "github", kind: "pr_open", key: "31", title: "PR #31: chore(deps)(deps): bump expo-localization from 57.0.1 to 58.0.5", url: "https://github.com/x/adminli/pull/31" }));
  expect(e.badge).toBe("dep_update_pr");
  expect(e.plain).toBe("expo-localization 57.0.1 → 58.0.5");
  expect(e.facts).toMatchObject({ pr: 31, dep: "expo-localization", from: "57.0.1", to: "58.0.5" });
  expect(e.links).toEqual([{ kind: "pr", label: "PR #31", href: "https://github.com/x/adminli/pull/31" }]);
  expect(e.project).toBe("adminli");
  expect(e.brief).toContain("Review PR #31");
});

test("#321: a stale branch names the branch; #386: a waiting thread names the thread", () => {
  const b = explainAttention(row({ id: 321, kind: "stale_branch", key: "feat/multi-project-ui", title: "feat/multi-project-ui: no commit for 26 days, not merged into main" }));
  expect(b).toMatchObject({ badge: "stale_branch", plain: "feat/multi-project-ui", facts: { branch: "feat/multi-project-ui", days: 26, base: "main" } });
  expect(b.links).toEqual([{ kind: "branch", label: "feat/multi-project-ui" }]);
  const t = explainAttention(row({ id: 386, source: "engine", kind: "thread_waiting", key: "542880", title: "thread waiting 2d: Complete waselni project", facts: { thread: 542880, threadTitle: "Complete waselni project", since: 1000 } }));
  expect(t).toMatchObject({ badge: "thread_waiting", plain: "Complete waselni project" });
  expect(t.links).toEqual([{ kind: "thread", label: "#542880" }]);
  expect(t.brief).toBeDefined();
});

test("plainPrTitle: collapses (x)(x), drops a conventional prefix, keeps an ordinary title", () => {
  expect(plainPrTitle("chore(deps)(deps): bump next from 15.5.15 to 16.4.3")).toEqual({ title: "next 15.5.15 → 16.4.3", dep: { name: "next", from: "15.5.15", to: "16.4.3" } });
  expect(plainPrTitle("Bump @types/node from 20.1.0 to 22.0.0 in /web")).toEqual({ title: "@types/node 20.1.0 → 22.0.0", dep: { name: "@types/node", from: "20.1.0", to: "22.0.0" } });
  expect(plainPrTitle("feat(auth)!: add Telegram login")).toEqual({ title: "Add Telegram login" });
  expect(plainPrTitle("Fix the cart total")).toEqual({ title: "Fix the cart total" });
});

test("an unknown kind or a row without facts still explains itself; never a throw", () => {
  const u = explainAttention(row({ kind: "brand_new_kind", title: "something new" }));
  expect(u).toMatchObject({ badge: "other", plain: "something new", links: [] });
  expect(u.brief).toBeUndefined(); // no template: → todo is refused, and the view says so
  const n = explainAttention(row({ source: "note", kind: "note_finding", title: "Dependabot titles say (deps)(deps)", fromProject: "neo" }));
  expect(n).toMatchObject({ badge: "note_finding", plain: "Dependabot titles say (deps)(deps)" });
});

// Review fixes (ADR-0059).
import { attentionActions, attentionTitle } from "../src/engine/attention-actions";
import { attentionBrief } from "../src/engine/attention-briefs";
import { liveDrafts, reconcile } from "../src/engine/attention";
import { openLedger } from "../src/engine/ledger";

test("review: braces in user text survive the brief; a note_question keeps its badge; an unknown kind offers no → todo", () => {
  expect(attentionBrief({ kind: "dirty", key: "k", title: "fix {lang} key in 3 files", project: "p" })).toContain("fix {lang} key in 3 files");
  expect(explainAttention(row({ source: "note", kind: "note_question", title: "which queue?" })).badge).toBe("note_question");
  expect(attentionActions({ kind: "brand_new_kind" })).toEqual(["snooze", "dismiss"]);
  expect(attentionActions({ kind: "stale_branch" })).toEqual(["todo", "snooze", "dismiss"]);
});

test("review: Telegram lines carry the English reason with its facts; a reason with a gap is left off", () => {
  const full = attentionTitle(row({ kind: "stale_branch", key: "feat/x", title: "t", facts: { branch: "feat/x", days: 26, base: "main" } }), 0);
  expect(full).toBe("[Stale branch] feat/x — No commit for 26 days, and not merged into main.");
  const pr = attentionTitle(row({ source: "github", kind: "pr_open", key: "31", title: "PR #31: Fix the cart", facts: { pr: 31, prTitle: "Fix the cart", draft: 0 } }), 0);
  expect(pr).toBe("[Open PR] Fix the cart — Pull request #31 is open and not merged.");
  const gap = explainAttention(row({ source: "engine", kind: "queue_paused", title: "todo queue paused 7h: #3 failed" }));
  expect(gap.reasonOk).toBe(false); // no `since` on an old row
  expect(attentionTitle(row({ source: "engine", kind: "queue_paused", title: "todo queue paused 7h: #3 failed" }), 0)).toBe("[Paused queue] #3 failed");
});

test("review: a live row re-fed by a failed read keeps its stored facts", () => {
  const led = openLedger(":memory:");
  reconcile(led, "git", "p", [{ project: "p", folder: "/p", source: "git", kind: "stale_branch", key: "b", title: "t", severity: "normal", facts: { branch: "b", days: 3, base: "main" } }], 1);
  expect(liveDrafts(led, "git", new Set(["stale_branch"]))[0]!.facts).toEqual({ branch: "b", days: 3, base: "main" });
});
