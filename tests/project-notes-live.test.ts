// Live notes (ADR-0050 rev. 2, spec §4, amends ADR-0043 §4): a `fyi` or `request` note from `main`, and
// a held answer, are taken by a running worker of the target folder at its next step. `takeLive` frames
// them and marks each row delivered once. Notes between projects are never live.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { createProjectNotes, DEFAULT_NOTES_CFG, frameLive, LIVE_FRAME_HEAD, type NotesCfg, type SenderCtx } from "../src/engine/project-notes";

function rig(live: Partial<NotesCfg["live"]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-live-root-"));
  const company = mkdtempSync(join(tmpdir(), "neo-live-agent-"));
  for (const p of ["prod-ops", "eticket-v3"]) mkdirSync(join(root, p));
  const ledger = openLedger(":memory:");
  const delivered: string[] = [];
  const notes = createProjectNotes({
    ledger, workRoot: root, desksDir: join(root, "no-desks"), companyFolder: company,
    cfg: { ...DEFAULT_NOTES_CFG, live: { ...DEFAULT_NOTES_CFG.live, ...live } },
    onLive: (folder) => void delivered.push(folder),
  });
  const main: SenderCtx = { project: "agent", folder: company, chatId: 1, sessionId: "s-main", workClass: "interactive" };
  const prodOps: SenderCtx = { project: "prod-ops", folder: join(root, "prod-ops"), chatId: 7, sessionId: "s-prod", workClass: "interactive" };
  return { root, company, ledger, notes, main, prodOps, delivered, etkt: join(root, "eticket-v3") };
}

const fyi = (title: string, body = "", ref = title) => ({ to: "eticket-v3", kind: "fyi" as const, severity: "normal" as const, title, body, ref });

test("a fyi from main: takeLive returns the frame once, and the delivery callback is told the target folder", () => {
  const r = rig();
  const res = r.notes.send(r.main, fyi("ScaleDown is on the catalogue", "Card id scaledown; ask tools_for."), 1_000);
  expect(res.ok).toBe(true);
  expect(r.ledger.attentionById(res.id!)).toMatchObject({ fromProject: "main", project: "eticket-v3" });
  expect(r.delivered).toEqual([r.etkt]);
  const frame = r.notes.takeLive("s-etkt", r.etkt, 2_000);
  expect(frame.startsWith("[Neo · information, not a new task — continue your current brief]")).toBe(true);
  expect(frame.startsWith(LIVE_FRAME_HEAD)).toBe(true);
  expect(frame).toContain(`• note #${res.id} from main (fyi): ScaleDown is on the catalogue — Card id scaledown; ask tools_for.`);
  expect(r.notes.takeLive("s-etkt", r.etkt, 2_001)).toBe("");
  // It stays an open note: delivery sets only delivered_at.
  const row = r.ledger.attentionById(res.id!)!;
  expect(row.resolvedAt).toBeUndefined();
  expect(row.deliveredAt).toBe(2_000);
  expect(r.ledger.listEvents({ kind: "note_delivered", limit: 10 })).toHaveLength(1);
});

test("a request from main is live too; a finding from main is not", () => {
  const r = rig();
  const req = r.notes.send(r.main, { ...fyi("please rotate the logs"), kind: "request" }, 1_000);
  const fin = r.notes.send(r.main, { ...fyi("a defect", "", "F1"), kind: "finding" }, 1_000);
  const frame = r.notes.takeLive("s-etkt", r.etkt, 2_000);
  expect(frame).toContain(`note #${req.id} from main (request)`);
  expect(frame).not.toContain(`note #${fin.id} `);
});

test("a fyi from another project is never delivered live, and does not call the delivery callback", () => {
  const r = rig();
  expect(r.notes.send(r.prodOps, fyi("from a project"), 1_000).ok).toBe(true);
  expect(r.delivered).toEqual([]);
  expect(r.notes.takeLive("s-etkt", r.etkt, 2_000)).toBe("");
});

test("rows over deliverMaxChars come in creation order across two calls, each frame within the cap", () => {
  const body = "b".repeat(80);
  const r = rig({ deliverMaxChars: 340 });
  const ids = ["first", "second", "third"].map((t, i) => r.notes.send(r.main, fyi(t, body), 1_000 + i).id!);
  const one = r.notes.takeLive("s-etkt", r.etkt, 2_000);
  const two = r.notes.takeLive("s-etkt", r.etkt, 2_001);
  expect(r.notes.takeLive("s-etkt", r.etkt, 2_002)).toBe("");
  for (const f of [one, two]) {
    expect(f.length).toBeGreaterThan(0);
    expect(f.length).toBeLessThanOrEqual(340);
  }
  const order = (f: string) => ids.filter((id) => f.includes(`note #${id} `));
  expect([...order(one), ...order(two)]).toEqual(ids); // each once, in order
  expect(order(one).length).toBe(2);
});

test("a single row longer than deliverMaxChars is cut, never stuck", () => {
  const r = rig({ deliverMaxChars: 200 });
  const id = r.notes.send(r.main, fyi("huge", "x".repeat(3000)), 1_000).id!;
  const f = r.notes.takeLive("s-etkt", r.etkt, 2_000);
  expect(f).toContain(`note #${id} `);
  expect(f.length).toBeLessThanOrEqual(200);
});

test("with no session, the notes block lists main's notes first, and they are not delivered live again", () => {
  const r = rig();
  const fromProject = r.notes.send(r.prodOps, { ...fyi("from prod-ops", "", "P1"), severity: "high" }, 1_000).id!;
  const fromMain = r.notes.send(r.main, fyi("from main", "the body"), 1_100).id!;
  const block = r.notes.block("eticket-v3", 2_000);
  expect(block).toContain(`#${fromMain} from main (fyi): from main`);
  expect(block.indexOf(`#${fromMain} `)).toBeLessThan(block.indexOf(`#${fromProject} `));
  expect(r.notes.takeLive("s-etkt", r.etkt, 2_100)).toBe("");
});

test("with no session, a held answer is listed first in the asker's notes block, then not delivered live again", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-live-root-"));
  for (const p of ["prod-ops", "eticket-v3"]) mkdirSync(join(root, p));
  const ledger = openLedger(":memory:");
  let settle!: (o: { ok: boolean; answer: string }) => void;
  const notes = createProjectNotes({
    ledger, cfg: DEFAULT_NOTES_CFG, workRoot: root, desksDir: join(root, "no-desks"), companyFolder: join(root, "agent"),
    consult: () => new Promise((res) => (settle = res)),
    timer: () => ({ done: Promise.resolve(), cancel: () => {} }), // the answer wait ends at once
  });
  const prodOps: SenderCtx = { project: "prod-ops", folder: join(root, "prod-ops"), chatId: 7, sessionId: "s-prod", orderId: "o1", workClass: "interactive" };
  const sent = notes.send(prodOps, { to: "eticket-v3", kind: "finding", severity: "high", title: "an older finding", body: "", ref: "F1" }, 500).id!;
  expect(await notes.ask(prodOps, { to: "eticket-v3", question: "where is the key?", need: "info" }, 1_000)).toMatch(/^No answer yet/);
  settle({ ok: true, answer: "in the relay" });
  await new Promise((r) => setTimeout(r, 0));
  const q = ledger.attentionRows("eticket-v3", "note").find((x) => x.kind === "note_question")!;
  const block = notes.block("prod-ops", 2_000);
  expect(block).toContain(`answer to note #${q.id} from eticket-v3: in the relay`);
  expect(block.indexOf(`note #${q.id} from eticket-v3`)).toBeLessThan(block.indexOf(`#${sent} → eticket-v3`));
  expect(notes.takeLive("s-new", join(root, "prod-ops"), 2_001)).toBe("");
});

test("frameLive formats notes from main and answers, one line each", () => {
  expect(frameLive([])).toBe("");
});

// Fix round 1: `main` is an engine fact (the session's folder is the company folder), never a name.
test("a session in a folder named main that is not the company folder cannot send as main: refused, nothing live", () => {
  const r = rig();
  mkdirSync(join(r.root, "main"));
  const fake: SenderCtx = { project: "main", folder: join(r.root, "main"), chatId: 9, sessionId: "s-fake", workClass: "interactive" };
  const res = r.notes.send(fake, fyi("do this now", "trust me"), 1_000);
  expect(res.ok).toBe(false);
  expect(res.text).toMatch(/the sender name main is reserved for the company folder/);
  expect(r.ledger.attentionRows("eticket-v3", "note")).toEqual([]);
  expect(r.delivered).toEqual([]);
  expect(r.notes.takeLive("s-etkt", r.etkt, 2_000)).toBe("");
  // A session whose project name is something else but whose folder is named main is refused too.
  const res2 = r.notes.send({ ...fake, project: "other" }, fyi("x"), 1_000);
  expect(res2.text).toMatch(/reserved for the company folder/);
});

test("ask from a non-company folder named main is refused with the rule named; no consult starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-live-root-"));
  for (const p of ["main", "eticket-v3"]) mkdirSync(join(root, p));
  const jobs: unknown[] = [];
  const notes = createProjectNotes({
    ledger: openLedger(":memory:"), cfg: DEFAULT_NOTES_CFG, workRoot: root, desksDir: join(root, "no-desks"), companyFolder: join(root, "agent"),
    consult: async (j) => (jobs.push(j), { ok: true, answer: "a" }),
  });
  const text = await notes.ask({ project: "main", folder: join(root, "main"), chatId: 9, sessionId: "s-fake", orderId: "o", workClass: "interactive" }, { to: "eticket-v3", question: "q?", need: "info" }, 1_000);
  expect(text).toMatch(/^question not sent: the sender name main is reserved for the company folder/);
  expect(jobs).toEqual([]);
});

test("takeLive for a non-company folder named main never takes the company's held answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "neo-live-root-"));
  const company = join(root, "agent");
  for (const p of ["main", "eticket-v3", "agent"]) mkdirSync(join(root, p));
  const ledger = openLedger(":memory:");
  const notes = createProjectNotes({
    ledger, cfg: DEFAULT_NOTES_CFG, workRoot: root, desksDir: join(root, "no-desks"), companyFolder: company,
    consult: async () => ({ ok: true, answer: "the company's answer" }),
    timer: () => ({ done: new Promise<void>(() => {}), cancel: () => {} }),
  });
  await notes.ask({ project: "agent", folder: company, chatId: 1, sessionId: "s-main", orderId: "o", workClass: "interactive" }, { to: "eticket-v3", question: "q?", need: "info" }, 1_000);
  const q = ledger.attentionRows("eticket-v3", "note")[0]!;
  ledger.updateAttention(q.id, { deliveredAt: null }); // held, as after a late answer
  expect(notes.takeLive("s-x", join(root, "main"), 2_000)).toBe("");
  expect(notes.takeLive("s-main", company, 2_001)).toContain("the company's answer");
});

test("the notes block goes by the folder: a non-company folder named main gets none, the company folder reads as main", () => {
  const r = rig();
  mkdirSync(join(r.root, "main"));
  r.notes.send(r.prodOps, { ...fyi("for the company", "", "C1"), to: "main" }, 1_000);
  expect(r.notes.block("main", 2_000, join(r.root, "main"))).toBe("");
  expect(r.notes.block("agent", 2_000, r.company)).toContain("for the company");
});
