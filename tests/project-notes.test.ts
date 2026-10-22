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
