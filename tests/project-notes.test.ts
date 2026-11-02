// Project notes (ADR-0043, spec AC1–AC17): one project tells another through the engine; a note is an
// attention item on the target; nothing a note does starts work.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger, type Ledger } from "../src/engine/ledger";
import { createProjectNotes, DEFAULT_NOTES_CFG, type NoteInput, type NotesCfg, type NotesDeps, type SenderCtx } from "../src/engine/project-notes";

const DAY = 86_400_000;

function world(over: { cfg?: Partial<NotesCfg>; deps?: Partial<NotesDeps> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-notes-root-"));
  const desks = mkdtempSync(join(tmpdir(), "neo-notes-desks-"));
  for (const p of ["prod-ops", "eticket-v3"]) mkdirSync(join(root, p));
  mkdirSync(join(desks, "inbox-desk"));
  const ledger = openLedger(":memory:");
  const lines: Array<{ text: string; cause?: unknown; kind?: string }> = [];
  const nowLines: number[] = [];
  const notes = createProjectNotes({
    ledger,
    cfg: { ...DEFAULT_NOTES_CFG, ...over.cfg },
    workRoot: root,
    desksDir: desks,
    trace: { outbound: (p) => (lines.push({ text: p.text, cause: p.cause, kind: p.kind }), lines.length) },
    notifyNow: (row) => void nowLines.push(row.id),
    ...over.deps,
    companyFolder: over.deps?.companyFolder ?? join(root, "agent"),
  });
  return { root, desks, ledger, notes, lines, nowLines };
}

const prodOps = (root: string): SenderCtx => ({ project: "prod-ops", folder: join(root, "prod-ops"), chatId: 7, cause: { msgId: 41, threadId: 40 } });
const d16 = (over: Partial<NoteInput> = {}): NoteInput => ({
  to: "eticket-v3", kind: "finding", severity: "normal", ref: "D16",
  title: "stale provider_pnr breaks hotel cancellation", body: "Seen in prod logs on booking BK-1.", refs: ["docs/findings.md#d16"], ...over,
});
const events = (l: Ledger, kind: string) => l.listEvents({ kind, limit: 50 });

// AC1
test("send raises one attention item on the target, keyed by sender and ref; the sender comes from the session", () => {
  const w = world();
  const r = w.notes.send(prodOps(w.root), d16(), 1_000);
  expect(r.ok).toBe(true);
  expect(r.text).toBe(`note #${r.id} → eticket-v3`);
  const [row] = w.ledger.attentionRows("eticket-v3", "note");
  expect(row).toMatchObject({
    id: r.id, project: "eticket-v3", folder: join(w.root, "eticket-v3"), source: "note", kind: "note_finding",
    key: "prod-ops:D16", title: "stale provider_pnr breaks hotel cancellation", severity: "normal",
    fromProject: "prod-ops", causeMsgId: 41,
  });
  expect(JSON.parse(row!.detail!)).toEqual({ body: "Seen in prod logs on booking BK-1.", refs: ["docs/findings.md#d16"] });
});

// AC2
test("the same sender and ref refreshes the row; a resolved one opens again with its resolution, ack, snooze and todo cleared", () => {
  const w = world();
  const id = w.notes.send(prodOps(w.root), d16(), 1_000).id!;
  expect(w.notes.send(prodOps(w.root), d16({ title: "D16 still seen", severity: "high" }), 2_000).id).toBe(id);
  expect(w.ledger.attentionRows("eticket-v3", "note")).toHaveLength(1);
  expect(w.ledger.attentionById(id)).toMatchObject({ title: "D16 still seen", severity: "high", lastSeen: 2_000, firstSeen: 1_000 });
  w.ledger.updateAttention(id, { resolvedAt: 3_000, resolution: JSON.stringify({ how: "not_needed", reason: "x" }), ackedAt: 2_500, snoozedUntil: 9_000, todoId: 4 });
  expect(w.notes.send(prodOps(w.root), d16(), 4_000).id).toBe(id);
  const row = w.ledger.attentionById(id)!;
  expect(row.resolvedAt).toBeUndefined();
  expect(row.resolution).toBeUndefined();
  expect(row.ackedAt).toBeUndefined();
  expect(row.snoozedUntil).toBeUndefined();
  expect(row.todoId).toBeUndefined();
});

// AC3
const REFUSALS: Array<[string, (root: string) => Partial<NoteInput>, RegExp]> = [
  ["an unknown project", () => ({ to: "nope" }), /no project named nope/],
  ["a desk", () => ({ to: "inbox-desk" }), /no project named inbox-desk/],
  ["the sender itself", () => ({ to: "prod-ops" }), /cannot send a note to itself/],
  ["an absolute path", (root) => ({ to: join(root, "eticket-v3") }), /a project name, not a path/],
  ["a path with ..", () => ({ to: "../eticket-v3" }), /a project name, not a path/],
  ["an unknown kind", () => ({ kind: "order" as NoteInput["kind"] }), /kind must be finding, fyi or request/],
  ["an unknown severity", () => ({ severity: "urgent" as NoteInput["severity"] }), /severity must be high, normal or low/],
  ["an empty title", () => ({ title: "  " }), /needs a title/],
  ["a long title", () => ({ title: "t".repeat(121) }), /title is over 120 characters/],
  ["a long body", () => ({ body: "b".repeat(4001) }), /body is over 4000 characters/],
  ["too many refs", () => ({ refs: Array.from({ length: 11 }, (_, i) => `r${i}`) }), /more than 10 refs/],
  ["a long ref entry", () => ({ refs: ["r".repeat(201)] }), /a ref is over 200 characters/],
  ["an empty ref", () => ({ ref: "" }), /needs a ref/],
  ["a secret in the body", () => ({ body: `use DB_PASSWORD=${"s3cr3t" + "Value9"} to log in` }), /looks like a secret \(assignment\)/],
  ["a secret in a ref", () => ({ refs: [`${"gh" + "p_"}${"a1".repeat(18)}`] }), /looks like a secret \(github_token\)/],
];
for (const [what, input, why] of REFUSALS) {
  test(`send refuses ${what}, stores nothing and records the refusal`, () => {
    const w = world();
    const r = w.notes.send(prodOps(w.root), d16(input(w.root)), 1_000);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(why);
    expect(w.ledger.attentionRows("eticket-v3", "note")).toEqual([]);
    expect(w.lines).toEqual([]);
  });
}

test("a secret refusal never repeats the secret", () => {
  const w = world();
  const value = "s3cr3t" + "Value9";
  const r = w.notes.send(prodOps(w.root), d16({ body: `PASSWORD=${value}` }), 1_000);
  expect(r.text).not.toContain(value);
});

test("caps: notes per sender per day, and open notes per sender and target; a refresh is not a new note", () => {
  const w = world({ cfg: { maxPerSenderPerDay: 3, maxOpenPerPair: 2 } });
  const s = prodOps(w.root);
  expect(w.notes.send(s, d16({ ref: "a" }), 1_000).ok).toBe(true);
  expect(w.notes.send(s, d16({ ref: "b" }), 1_000).ok).toBe(true);
  const full = w.notes.send(s, d16({ ref: "c" }), 1_000);
  expect(full).toMatchObject({ ok: false });
  expect(full.text).toMatch(/2 open notes to eticket-v3 \(notes.maxOpenPerPair\)/);
  expect(w.notes.send(s, d16({ ref: "a", title: "refreshed" }), 1_100).ok).toBe(true); // a refresh passes
  mkdirSync(join(w.root, "gold"));
  expect(w.notes.send(s, d16({ to: "gold", ref: "g1" }), 1_200).ok).toBe(true);
  const day = w.notes.send(s, d16({ to: "gold", ref: "g2" }), 1_300);
  expect(day.text).toMatch(/3 notes in 24 hours \(notes.maxPerSenderPerDay\)/);
  expect(w.notes.send(s, d16({ to: "gold", ref: "g2" }), 1_001 + DAY).ok).toBe(true); // the day passed
});

// AC4
test("a send records note_sent and one trace line under the cause, with the title and never the body", () => {
  const w = world();
  const r = w.notes.send(prodOps(w.root), d16(), 1_000);
  expect(w.lines).toEqual([{ text: `note #${r.id} → eticket-v3: stale provider_pnr breaks hotel cancellation`, cause: { msgId: 41, threadId: 40 }, kind: "notice" }]);
  expect(JSON.stringify(w.lines)).not.toContain("Seen in prod logs");
  expect(events(w.ledger, "note_sent")[0]?.data).toMatchObject({ id: r.id, from: "prod-ops", to: "eticket-v3", kind: "finding", ref: "D16" });
});

test("a refusal records note_refused with the reason", () => {
  const w = world();
  w.notes.send(prodOps(w.root), d16({ to: "nope" }), 1_000);
  expect(events(w.ledger, "note_refused")[0]?.data).toMatchObject({ from: "prod-ops", to: "nope" });
});

// 1.5: a scan can never resolve a note; notes are pruned on their own retention.
test("reconcile and reconcileAll never touch notes, even when asked for source note", async () => {
  const { reconcile, reconcileAll } = await import("../src/engine/attention");
  const w = world();
  const id = w.notes.send(prodOps(w.root), d16(), 1_000).id!;
  reconcileAll(w.ledger, "engine", [], 2_000, { keepResolvedMs: 1 });
  expect(reconcile(w.ledger, "note", "eticket-v3", [], 2_000)).toEqual({ opened: [], resolved: [] });
  expect(reconcileAll(w.ledger, "note", [], 2_000, { keepResolvedMs: 1 })).toEqual({ opened: [], resolved: [] });
  expect(w.ledger.attentionById(id)?.resolvedAt).toBeUndefined();
});

test("prune deletes notes resolved longer ago than notes.keepResolvedDays, and keeps dismissed ones", () => {
  const w = world({ cfg: { keepResolvedDays: 1 } });
  const s = prodOps(w.root);
  const old = w.notes.send(s, d16({ ref: "old" }), 1_000).id!;
  const fresh = w.notes.send(s, d16({ ref: "fresh" }), 1_000).id!;
  const dismissed = w.notes.send(s, d16({ ref: "dis" }), 1_000).id!;
  w.ledger.updateAttention(old, { resolvedAt: 2_000 });
  w.ledger.updateAttention(fresh, { resolvedAt: 2_000 + DAY });
  w.ledger.updateAttention(dismissed, { resolvedAt: 2_000, dismissed: true });
  w.notes.prune(2_001 + DAY);
  expect(w.ledger.attentionById(old)).toBeUndefined();
  expect(w.ledger.attentionById(fresh)).toBeDefined();
  expect(w.ledger.attentionById(dismissed)).toBeDefined();
});

// AC5: the routing table — no route starts work.
test("noteRoute: a request or a high finding is told now; everything else waits for the digest", async () => {
  const { noteRoute } = await import("../src/engine/project-notes");
  expect(noteRoute("request", "low")).toBe("now");
  expect(noteRoute("finding", "high")).toBe("now");
  expect(noteRoute("finding", "normal")).toBe("digest");
  expect(noteRoute("fyi", "high")).toBe("digest");
});

test("a now-routed note is told once when it opens (not on a refresh); no note adds a todo or a session", () => {
  const w = world();
  const s = prodOps(w.root);
  const id = w.notes.send(s, d16({ kind: "request" }), 1_000).id!;
  w.notes.send(s, d16({ kind: "request", title: "again" }), 2_000);
  w.notes.send(s, d16({ ref: "low", kind: "fyi", severity: "high" }), 2_000);
  expect(w.nowLines).toEqual([id]);
  expect(w.ledger.attentionById(id)?.todoId).toBeUndefined();
  expect(w.ledger.listTodos({})).toEqual([]);
});

test("noteNowText: the line the operator gets for a request or a high finding — sender, target, kind, title; never the body", async () => {
  const { noteNowText } = await import("../src/engine/project-notes");
  const w = world();
  const id = w.notes.send(prodOps(w.root), d16({ kind: "request", severity: "high" }), 1_000).id!;
  const text = noteNowText(w.ledger.attentionById(id)!);
  expect(text).toBe(`📝 note #${id} prod-ops → eticket-v3 (request, high): stale provider_pnr breaks hotel cancellation`);
  expect(text).not.toContain("Seen in prod logs");
});

// ---- Phase 2: the target and the sender read and close notes (AC6–AC12) ----

const etkt = (root: string): SenderCtx => ({ project: "eticket-v3", folder: join(root, "eticket-v3"), chatId: 8 });
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return r.stdout.toString().trim();
};
/** Make the target a repo with one commit on `main`; returns that commit and a dangling one. */
function repo(root: string): { onBranch: string; dangling: string } {
  const dir = join(root, "eticket-v3");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "fix D16");
  const onBranch = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", "HEAD^{tree}");
  const dangling = git(dir, "commit-tree", tree, "-m", "nowhere");
  return { onBranch, dangling };
}

// AC7
test("list shows my open notes, severity first; list from shows the notes I sent in every state", () => {
  const w = world();
  const s = prodOps(w.root);
  const a = w.notes.send(s, d16({ ref: "a", title: "low one", severity: "low" }), 1_000).id!;
  const b = w.notes.send(s, d16({ ref: "b", title: "high one", severity: "high" }), 1_000).id!;
  const c = w.notes.send(s, d16({ ref: "c", title: "gone" }), 1_000).id!;
  w.notes.withdraw("prod-ops", c, 2_000);
  expect(w.notes.list("eticket-v3", { box: "to" }, 3_000).map((n) => n.id)).toEqual([b, a]);
  const sent = w.notes.list("prod-ops", { box: "from" }, 3_000);
  expect(sent.map((n) => [n.id, n.state])).toEqual([[b, "open"], [a, "open"], [c, "withdrawn"]]);
  expect(w.notes.list("prod-ops", { box: "to" }, 3_000)).toEqual([]);
});

test("show gives the full body and refs, only to the target or the sender", () => {
  const w = world();
  mkdirSync(join(w.root, "gold"));
  const id = w.notes.send(prodOps(w.root), d16(), 1_000).id!;
  expect(w.notes.show("eticket-v3", id)).toMatchObject({ id, from: "prod-ops", to: "eticket-v3", kind: "finding", body: "Seen in prod logs on booking BK-1.", refs: ["docs/findings.md#d16"] });
  expect(w.notes.show("prod-ops", id)?.id).toBe(id);
  expect(w.notes.show("gold", id)).toBeUndefined();
});

// AC7, AC10
test("ack is the target's: it marks the note acknowledged; anyone else is refused", () => {
  const w = world();
  const id = w.notes.send(prodOps(w.root), d16(), 1_000).id!;
  expect(w.notes.ack("prod-ops", id, 2_000)).toMatchObject({ ok: false });
  expect(w.notes.ack("eticket-v3", id, 2_000)).toMatchObject({ ok: true });
  expect(w.notes.show("eticket-v3", id)?.state).toBe("acknowledged");
});

// AC8
test("resolve fixed: a commit on a branch of the target resolves it; the sender sees the commit", async () => {
  const w = world();
  const { onBranch } = repo(w.root);
  const id = w.notes.send(prodOps(w.root), d16(), 1_000).id!;
  const r = await w.notes.resolve("eticket-v3", id, { how: "fixed", commit: onBranch.slice(0, 9) }, 2_000);
  expect(r).toMatchObject({ ok: true });
  const row = w.ledger.attentionById(id)!;
  expect(row.resolvedAt).toBe(2_000);
  expect(JSON.parse(row.resolution!)).toMatchObject({ how: "fixed", commit: onBranch, by: "eticket-v3" });
  expect(w.notes.list("prod-ops", { box: "from" }, 3_000)[0]).toMatchObject({ id, state: "fixed" });
});

test("resolve fixed refuses an unknown sha, a commit on no branch, a non-sha and a git error — nothing changes", async () => {
  const w = world();
  const { dangling } = repo(w.root);
  const id = w.notes.send(prodOps(w.root), d16(), 1_000).id!;
  for (const commit of ["deadbeef1234", dangling, "HEAD", "main; rm -rf /"]) {
    expect((await w.notes.resolve("eticket-v3", id, { how: "fixed", commit }, 2_000)).ok).toBe(false);
  }
  const broken = world({ deps: { exec: async () => ({ code: 128, out: "", err: "fatal: boom" }) } });
  const id2 = broken.notes.send(prodOps(broken.root), d16(), 1_000).id!;
  expect(await broken.notes.resolve("eticket-v3", id2, { how: "fixed", commit: "abcdef1" }, 2_000)).toMatchObject({ ok: false });
  expect(w.ledger.attentionById(id)?.resolvedAt).toBeUndefined();
  expect(broken.ledger.attentionById(id2)?.resolvedAt).toBeUndefined();
});

// AC9, AC10
test("resolve not_needed or duplicate needs a reason (size- and secret-checked); only the target resolves", async () => {
  const w = world();
  const id = w.notes.send(prodOps(w.root), d16(), 1_000).id!;
  expect((await w.notes.resolve("eticket-v3", id, { how: "not_needed" }, 2_000)).text).toMatch(/needs a reason/);
  expect((await w.notes.resolve("eticket-v3", id, { how: "duplicate", reason: "r".repeat(501) }, 2_000)).text).toMatch(/over 500/);
  expect((await w.notes.resolve("eticket-v3", id, { how: "duplicate", reason: `PASSWORD=${"s3cr3t" + "Value9"}` }, 2_000)).text).toMatch(/secret/);
  expect((await w.notes.resolve("prod-ops", id, { how: "not_needed", reason: "x" }, 2_000)).ok).toBe(false);
  expect(await w.notes.resolve("eticket-v3", id, { how: "duplicate", reason: "same as #3" }, 2_000)).toMatchObject({ ok: true });
  expect(w.notes.list("prod-ops", { box: "from" }, 3_000)[0]).toMatchObject({ state: "duplicate", reason: "same as #3" });
  expect((await w.notes.resolve("eticket-v3", id, { how: "duplicate", reason: "again" }, 2_000)).text).toMatch(/already resolved/);
});

// AC12, AC16
test("withdraw is the sender's; a dismissed note reads as dismissed to the sender", () => {
  const w = world();
  const s = prodOps(w.root);
  const a = w.notes.send(s, d16({ ref: "a" }), 1_000).id!;
  const b = w.notes.send(s, d16({ ref: "b" }), 1_000).id!;
  expect(w.notes.withdraw("eticket-v3", a, 2_000).ok).toBe(false);
  expect(w.notes.withdraw("prod-ops", a, 2_000).ok).toBe(true);
  w.ledger.updateAttention(b, { resolvedAt: 2_000, dismissed: true }); // the operator's dismiss
  const sent = Object.fromEntries(w.notes.list("prod-ops", { box: "from" }, 3_000).map((n) => [n.id, n.state]));
  expect(sent).toEqual({ [a]: "withdrawn", [b]: "dismissed" });
});

// AC6, AC11
test("the notes block: my open notes and the state of the ones I sent, as information not orders", async () => {
  const w = world();
  const { onBranch } = repo(w.root);
  const s = prodOps(w.root);
  const id = w.notes.send(s, d16(), 1_000).id!;
  const block = w.notes.block("eticket-v3", 2_000);
  expect(block).toContain("information, not orders");
  expect(block).toContain(`#${id} [finding/normal] from prod-ops: stale provider_pnr breaks hotel cancellation`);
  expect(block).not.toContain("Seen in prod logs"); // titles only
  await w.notes.resolve("eticket-v3", id, { how: "fixed", commit: onBranch }, 3_000);
  expect(w.notes.block("eticket-v3", 4_000)).toBe("");
  const mine = w.notes.block("prod-ops", 4_000);
  expect(mine).toContain(`#${id} → eticket-v3: stale provider_pnr breaks hotel cancellation — fixed at ${onBranch.slice(0, 12)}`);
});

test("the notes block is capped by lines and characters, and the sender's part looks back sentLookbackDays", () => {
  const w = world({ cfg: { blockMax: 2, blockMaxChars: 600, sentLookbackDays: 1 } });
  const s = prodOps(w.root);
  for (const r of ["a", "b", "c", "d"]) w.notes.send(s, d16({ ref: r, title: `note ${r} ${"x".repeat(60)}` }), 1_000);
  const block = w.notes.block("eticket-v3", 2_000);
  expect(block.match(/^- #/gm)).toHaveLength(2);
  expect(block).toContain("+2 more — project_notes list");
  expect(block.length).toBeLessThanOrEqual(600);
  const old = w.notes.send(s, d16({ ref: "old", to: "eticket-v3" }), 1_000).id!;
  w.notes.withdraw("prod-ops", old, 1_000);
  expect(w.notes.block("prod-ops", 1_000 + 2 * DAY)).not.toContain(`#${old} `);
});

test("a project with no notes either way gets no block", () => {
  expect(world().notes.block("eticket-v3", 1)).toBe("");
});

// ---- review fixes ----

test("a reopen counts against the daily cap and is not a way to ping the operator without limit", () => {
  const w = world({ cfg: { maxPerSenderPerDay: 2 } });
  const s = prodOps(w.root);
  expect(w.notes.send(s, d16({ kind: "request" }), 1_000).ok).toBe(true);
  w.notes.withdraw("prod-ops", w.ledger.attentionRows("eticket-v3", "note")[0]!.id, 1_001);
  expect(w.notes.send(s, d16({ kind: "request" }), 1_002).ok).toBe(true); // reopen #1 — the second send today
  w.notes.withdraw("prod-ops", w.ledger.attentionRows("eticket-v3", "note")[0]!.id, 1_003);
  const third = w.notes.send(s, d16({ kind: "request" }), 1_004);
  expect(third.ok).toBe(false);
  expect(third.text).toMatch(/notes.maxPerSenderPerDay/);
  expect(w.nowLines).toHaveLength(2);
});

test("the same ref with another kind updates the one note (no second row), and a change up to a request is told", () => {
  const w = world();
  const s = prodOps(w.root);
  const id = w.notes.send(s, d16({ kind: "fyi", severity: "low" }), 1_000).id!;
  expect(w.notes.send(s, d16({ kind: "request", severity: "low" }), 2_000).id).toBe(id);
  expect(w.ledger.attentionRows("eticket-v3", "note")).toHaveLength(1);
  expect(w.ledger.attentionById(id)).toMatchObject({ kind: "note_request" });
  expect(w.nowLines).toEqual([id]);
});

test("a ref may not contain ':' (it would collide with another sender's key)", () => {
  const w = world();
  const r = w.notes.send(prodOps(w.root), d16({ ref: "b:c" }), 1_000);
  expect(r.ok).toBe(false);
  expect(r.text).toMatch(/ref may not contain ':'/);
});

test("resolve does not overwrite a note withdrawn while its git check ran", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const sha = "a".repeat(40);
  const w = world({
    deps: {
      exec: async (cmd) => {
        await gate;
        return cmd.includes("rev-parse") ? { code: 0, out: sha, err: "" } : { code: 0, out: "main\n", err: "" };
      },
    },
  });
  const id = w.notes.send(prodOps(w.root), d16(), 1_000).id!;
  const pending = w.notes.resolve("eticket-v3", id, { how: "fixed", commit: "abcdef1" }, 2_000);
  w.notes.withdraw("prod-ops", id, 1_500);
  release();
  expect((await pending).ok).toBe(false);
  expect(JSON.parse(w.ledger.attentionById(id)!.resolution!)).toMatchObject({ how: "withdrawn" });
});
