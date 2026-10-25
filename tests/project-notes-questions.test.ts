// Questions on project notes (ADR-0050 rev. 2, spec §3, §10 criteria 1–6, 9, 12): `project_notes ask`
// stores a `question` note through the shared send path and a consult run answers it. The consult is a
// fake here; the clock is a fake timer the test fires.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger, type Ledger } from "../src/engine/ledger";
import type { BlockedOn } from "../src/engine/liveness";
import {
  createProjectNotes, DEFAULT_NOTES_CFG, noteRoute, readNotesCfg,
  type ConsultRunner, type NotesCfg, type NotesDeps, type SenderCtx,
} from "../src/engine/project-notes";

const MIN = 60_000;

type Job = Parameters<ConsultRunner>[0];
type Outcome = { answer: string; ok: boolean; reason?: string };

/** A consult whose runs the test settles by hand (`auto`: settle at once with this outcome). */
function fakeConsult(auto?: Outcome) {
  const jobs: Job[] = [];
  const pending: Array<{ resolve: (o: Outcome) => void; reject: (e: unknown) => void }> = [];
  const run: ConsultRunner = (job) => {
    jobs.push(job);
    if (auto) return Promise.resolve(auto);
    return new Promise<Outcome>((resolve, reject) => void pending.push({ resolve, reject }));
  };
  return { run, jobs, pending };
}

/** A fake answer-wait timer: it fires only when the test says so. */
function fakeTimer() {
  const armed: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  const timer = (ms: number) => {
    let fire!: () => void;
    const done = new Promise<void>((r) => (fire = r));
    const t = { ms, fire, cancelled: false };
    armed.push(t);
    return { done, cancel: () => void (t.cancelled = true) };
  };
  return { timer, armed, fireAll: () => armed.forEach((t) => t.fire()) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(over: { cfg?: Partial<NotesCfg>; questions?: Partial<NotesCfg["questions"]>; deps?: Partial<NotesDeps>; auto?: Outcome | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-q-root-"));
  const desks = mkdtempSync(join(tmpdir(), "neo-q-desks-"));
  const company = mkdtempSync(join(tmpdir(), "neo-q-agent-"));
  for (const p of ["prod-ops", "eticket-v3", "gold"]) mkdirSync(join(root, p));
  mkdirSync(join(desks, "inbox-desk"));
  const ledger = openLedger(":memory:");
  const lines: Array<{ text: string; cause?: unknown }> = [];
  const blocked: Array<{ sid: string; on: BlockedOn | undefined }> = [];
  const live: string[] = [];
  const consult = fakeConsult(over.auto === null ? undefined : (over.auto ?? { ok: true, answer: "Use the ScaleDown card: tools_for scaledown." }));
  const clock = fakeTimer();
  let now = 1_000_000;
  const cfg: NotesCfg = { ...DEFAULT_NOTES_CFG, ...over.cfg, questions: { ...DEFAULT_NOTES_CFG.questions, ...over.questions } };
  const deps: NotesDeps = {
    ledger, cfg, workRoot: root, desksDir: desks, companyFolder: company,
    trace: { outbound: (p) => (lines.push({ text: p.text, cause: p.cause }), lines.length) },
    consult: consult.run,
    blocked: (sid, on) => void blocked.push({ sid, on }),
    onLive: (folder) => void live.push(folder),
    timer: clock.timer,
    clock: () => now,
    ...over.deps,
  };
  const notes = createProjectNotes(deps);
  return { root, desks, company, ledger, lines, blocked, live, consult, clock, notes, deps, setNow: (t: number) => void (now = t) };
}

const prodOps = (root: string, over: Partial<SenderCtx> = {}): SenderCtx => ({
  project: "prod-ops", folder: join(root, "prod-ops"), chatId: 7, cause: { msgId: 41, threadId: 40 },
  sessionId: "s-prod", orderId: "o1", workClass: "interactive", ...over,
});
const etkt = (root: string, over: Partial<SenderCtx> = {}): SenderCtx => ({
  project: "eticket-v3", folder: join(root, "eticket-v3"), chatId: 8, sessionId: "s-etkt", orderId: "o2", workClass: "interactive", ...over,
});
const Q = "Where does the ScaleDown key live, and which tool calls it?";
const events = (l: Ledger, kind: string) => l.listEvents({ kind, limit: 50 });
const questions = (l: Ledger, project: string) => l.attentionRows(project, "note").filter((r) => r.kind === "note_question");

test("config: notes.questions and notes.live defaults, and a bad value keeps its default", () => {
  expect(DEFAULT_NOTES_CFG.questions).toEqual({
    enabled: true, answerWaitMs: 240_000, consultMaxTurns: 12, forkMaxOccupancyPct: 60, maxOpenPerPair: 1,
    maxPerOrderPerHour: 6, backgroundMaxPerOrder: 2, maxConcurrentConsults: 2, questionMaxChars: 1500, answerMaxChars: 4000,
  });
  expect(DEFAULT_NOTES_CFG.live).toEqual({ deliverMaxChars: 6000, holdMaxMs: 86_400_000 });
  const c = readNotesCfg({ questions: { enabled: false, answerWaitMs: -1, maxOpenPerPair: 3, questionMaxChars: "x" }, live: { deliverMaxChars: 0, holdMaxMs: 5 } });
  expect(c.questions).toMatchObject({ enabled: false, answerWaitMs: 240_000, maxOpenPerPair: 3, questionMaxChars: 1500 });
  expect(c.live).toEqual({ deliverMaxChars: 6000, holdMaxMs: 5 });
  expect(readNotesCfg({ questions: { enabled: "no" } }).questions.enabled).toBe(true);
  expect(readNotesCfg({ questions: 7, live: null }).questions).toEqual(DEFAULT_NOTES_CFG.questions);
});

test("noteRoute: a question waits for the digest — it is never told to the operator now", () => {
  for (const s of ["high", "normal", "low"] as const) expect(noteRoute("question", s)).toBe("digest");
});

// Criterion 1: every refusal starts no consult, stores no question, and names its config key (or the
// rule, where no knob governs it).
type Refusal = [what: string, why: RegExp, make: () => { r: ReturnType<typeof rig>; ask: () => Promise<string> }];
const plain = (over: Parameters<typeof rig>[0], from: (r: ReturnType<typeof rig>) => SenderCtx, to: string, question = Q): Refusal[2] => () => {
  const r = rig(over);
  return { r, ask: () => r.notes.ask(from(r), { to, question, need: "info" }, 1_000_000) };
};
const P = (r: ReturnType<typeof rig>) => prodOps(r.root);
const MAIN = (r: ReturnType<typeof rig>): SenderCtx => ({ ...prodOps(r.root), project: "agent", folder: r.company });
const REFUSALS: Refusal[] = [
  ["questions off", /notes\.questions\.enabled/, plain({ questions: { enabled: false } }, P, "eticket-v3")],
  ["no consult wired", /no consult runner is wired/, plain({ deps: { consult: undefined } }, P, "eticket-v3")],
  ["an unknown target", /no project named nope/, plain({}, P, "nope")],
  ["the sender itself", /cannot send a note to itself/, plain({}, P, "prod-ops")],
  ["a desk other than main", /no project named inbox-desk/, plain({}, P, "inbox-desk")],
  ["main asking main", /cannot send a note to itself/, plain({}, MAIN, "main")],
  ["a blank question", /a question needs text/, plain({}, P, "eticket-v3", "   ")],
  ["a long question", /notes\.questions\.questionMaxChars/, plain({}, P, "eticket-v3", "q".repeat(1501))],
  ["a secret question", /looks like a secret \(assignment\)/, plain({}, P, "eticket-v3", `is DB_PASSWORD=${"s3cr3t" + "Value9"} right?`)],
  ["an unknown need", /need must be info, resource or help/, () => {
    const r = rig();
    return { r, ask: () => r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "orders" as never }, 1_000_000) };
  }],
];
for (const [what, why, make] of REFUSALS) {
  test(`ask refuses ${what}: no consult, no question stored, the reason named`, async () => {
    const { r, ask } = make();
    const text = await ask();
    expect(text).toMatch(why);
    expect(text).toMatch(/^question not sent: /);
    expect(r.consult.jobs).toHaveLength(0);
    for (const p of ["eticket-v3", "main", "nope", "inbox-desk", "prod-ops"]) expect(questions(r.ledger, p)).toEqual([]);
    expect(events(r.ledger, "note_refused")).toHaveLength(1);
  });
}

test("a secret refusal never repeats the secret", async () => {
  const r = rig();
  const value = "s3cr3t" + "Value9";
  const text = await r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: `PASSWORD=${value}`, need: "info" }, 1_000_000);
  expect(text).not.toContain(value);
});

test("ask refuses a second open question to the same target (notes.questions.maxOpenPerPair)", async () => {
  const r = rig({ auto: null });
  void r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  r.clock.fireAll();
  await flush();
  const text = await r.notes.ask(prodOps(r.root, { orderId: "o9" }), { to: "eticket-v3", question: "another?", need: "info" }, 1_000_100);
  expect(text).toMatch(/notes\.questions\.maxOpenPerPair/);
  expect(r.consult.jobs).toHaveLength(1);
  // Another target is fine.
  void r.notes.ask(prodOps(r.root, { orderId: "o9" }), { to: "gold", question: "and you?", need: "info" }, 1_000_200);
  await flush();
  expect(r.consult.jobs).toHaveLength(2);
  r.consult.pending.forEach((p) => p.resolve({ ok: true, answer: "x" }));
});

test("ask caps questions per order per hour (notes.questions.maxPerOrderPerHour): counted at 59 min, gone at 61 min", async () => {
  const r = rig({ questions: { maxPerOrderPerHour: 2 } });
  const s = prodOps(r.root);
  const t0 = 1_000_000;
  expect(await r.notes.ask(s, { to: "eticket-v3", question: "one?", need: "info" }, t0)).toContain("answer from eticket-v3");
  expect(await r.notes.ask(s, { to: "gold", question: "two?", need: "info" }, t0 + 1)).toContain("answer from gold");
  const full = await r.notes.ask(s, { to: "eticket-v3", question: "three?", need: "info" }, t0 + 59 * MIN);
  expect(full).toMatch(/2 questions in the last hour \(notes\.questions\.maxPerOrderPerHour\)/);
  expect(r.consult.jobs).toHaveLength(2);
  expect(await r.notes.ask(s, { to: "eticket-v3", question: "three?", need: "info" }, t0 + 61 * MIN)).toContain("answer from eticket-v3");
  // Another order of the same project has its own count.
  expect(await r.notes.ask(prodOps(r.root, { orderId: "o7" }), { to: "gold", question: "four?", need: "info" }, t0 + 61 * MIN)).toContain("answer from gold");
});

test("background work has the lower cap (notes.questions.backgroundMaxPerOrder): counted at 59 min, gone at 61 min", async () => {
  const r = rig({ questions: { backgroundMaxPerOrder: 1 } });
  const s = prodOps(r.root, { workClass: "background" });
  const t0 = 1_000_000;
  expect(await r.notes.ask(s, { to: "eticket-v3", question: "one?", need: "info" }, t0)).toContain("answer from");
  const full = await r.notes.ask(s, { to: "gold", question: "two?", need: "info" }, t0 + 59 * MIN);
  expect(full).toMatch(/notes\.questions\.backgroundMaxPerOrder/);
  expect(await r.notes.ask(s, { to: "gold", question: "two?", need: "info" }, t0 + 61 * MIN)).toContain("answer from");
});

test("ask caps running consults (notes.questions.maxConcurrentConsults)", async () => {
  const r = rig({ auto: null, questions: { maxConcurrentConsults: 1 } });
  const first = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  const text = await r.notes.ask(etkt(r.root), { to: "gold", question: "busy?", need: "info" }, 1_000_001);
  expect(text).toMatch(/1 consult runs? already running \(notes\.questions\.maxConcurrentConsults\)/);
  expect(r.consult.jobs).toHaveLength(1);
  r.consult.pending[0]!.resolve({ ok: true, answer: "done" });
  await first;
  // The slot is free again.
  void r.notes.ask(etkt(r.root), { to: "gold", question: "busy?", need: "info" }, 1_000_002);
  await flush();
  expect(r.consult.jobs).toHaveLength(2);
  r.consult.pending[1]!.resolve({ ok: true, answer: "done" });
});

test("background work is refused while the interactive reserve is held; interactive work is not", async () => {
  const r = rig({ deps: { meter: { shouldThrottleBackground: () => true } } });
  const bg = await r.notes.ask(prodOps(r.root, { workClass: "background" }), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  expect(bg).toMatch(/subscriptionInteractiveReservePct/);
  expect(r.consult.jobs).toHaveLength(0);
  expect(await r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000)).toContain("answer from");
});

test("the existing send refusals apply to questions (notes.maxPerSenderPerDay)", async () => {
  const r = rig({ cfg: { maxPerSenderPerDay: 1 } });
  expect(r.notes.send(prodOps(r.root), { to: "gold", kind: "fyi", severity: "low", title: "t", body: "", ref: "F1" }, 1_000_000).ok).toBe(true);
  const text = await r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_001);
  expect(text).toMatch(/notes\.maxPerSenderPerDay/);
  expect(r.consult.jobs).toHaveLength(0);
});

test("send cannot forge a question: kind question is refused from the tool's args", () => {
  const r = rig();
  const res = r.notes.send(prodOps(r.root), { to: "eticket-v3", kind: "question" as never, severity: "normal", title: "t", body: "", ref: "X" }, 1);
  expect(res.ok).toBe(false);
  expect(res.text).toMatch(/kind must be finding, fyi or request/);
});

// Criterion 2
test("a good ask stores one question row, one note_sent event without the text, one trace line under the cause, and starts one consult in the target folder", async () => {
  const r = rig();
  const long = `${"Which provider keeps the PNR? ".repeat(6)}${Q}`;
  const text = await r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: long, need: "info" }, 1_000_000);
  const [row] = questions(r.ledger, "eticket-v3");
  expect(row).toMatchObject({
    project: "eticket-v3", folder: join(r.root, "eticket-v3"), source: "note", kind: "note_question", key: "prod-ops:q-o1-1",
    title: long.slice(0, 120).trim(), severity: "normal", fromProject: "prod-ops", causeMsgId: 41, fromSession: "s-prod",
  });
  expect(JSON.parse(row!.detail!)).toEqual({ body: long, refs: [] });
  const sent = events(r.ledger, "note_sent");
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent[0])).not.toContain("ScaleDown key live");
  expect(sent[0]).toMatchObject({ data: { from: "prod-ops", to: "eticket-v3", kind: "question", ref: "q-o1-1" } });
  const noteLines = r.lines.filter((l) => l.text.startsWith("note #"));
  expect(noteLines).toEqual([{ text: `note #${row!.id} → eticket-v3: ${row!.title}`, cause: { msgId: 41, threadId: 40 } }]);
  expect(r.consult.jobs).toHaveLength(1);
  expect(r.consult.jobs[0]).toMatchObject({ folder: join(r.root, "eticket-v3"), cause: { msgId: 41, threadId: 40 }, workClass: "interactive" });
  expect(r.consult.jobs[0]!.forkFrom).toBeUndefined();
  expect(r.consult.jobs[0]!.prompt).toContain(JSON.stringify(long));
  expect(r.consult.jobs[0]!.prompt).toContain("prod-ops");
  expect(text).toContain("Use the ScaleDown card");
  // The next question of the same order gets the next ref.
  await r.notes.ask(prodOps(r.root), { to: "gold", question: "second?", need: "help" }, 1_000_100);
  expect(questions(r.ledger, "gold")[0]!.key).toBe("prod-ops:q-o1-2");
});

test("`main` resolves to the company folder: the question is on main and the consult runs there", async () => {
  const r = rig();
  await r.notes.ask(prodOps(r.root), { to: "main", question: Q, need: "resource" }, 1_000_000);
  const [row] = questions(r.ledger, "main");
  expect(row).toMatchObject({ project: "main", folder: r.company, fromProject: "prod-ops" });
  expect(r.consult.jobs[0]!.folder).toBe(r.company);
});

test("need resource: the catalogue's matches go to the consult prompt and come first in the answer", async () => {
  const finds: unknown[] = [];
  const catalogue = {
    cards: [], errors: [], cfg: { replyMaxChars: 2000 } as never,
    find: (text: string, ctx: unknown) => (finds.push({ text, ctx }), [{ id: "scaledown", kind: "api", why: ["matches key"], how: "tool_api scaledown", allowed: true, score: 3 }] as never),
    relay: async () => "", hint: () => "",
  };
  const r = rig({ deps: { catalogue } });
  const text = await r.notes.ask(prodOps(r.root), { to: "main", question: Q, need: "resource" }, 1_000_000);
  expect(finds).toEqual([{ text: Q, ctx: { project: "prod-ops", folder: join(r.root, "prod-ops"), limit: 3 } }]);
  expect(r.consult.jobs[0]!.prompt).toContain("scaledown");
  expect(text.indexOf("scaledown")).toBeLessThan(text.indexOf("Use the ScaleDown card"));
  // need info: no search.
  await r.notes.ask(prodOps(r.root, { orderId: "o5" }), { to: "gold", question: "x?", need: "info" }, 1_000_000);
  expect(finds).toHaveLength(1);
});

// Criterion 3
const FORKS: Array<[string, { inTurn: boolean; lastSessionId?: string; sameSdk: boolean; occupancyPct?: number }, string | undefined]> = [
  ["forks an idle Claude target at 40 %", { inTurn: false, lastSessionId: "sdk-1", sameSdk: true, occupancyPct: 40 }, "sdk-1"],
  ["starts fresh at 70 %", { inTurn: false, lastSessionId: "sdk-1", sameSdk: true, occupancyPct: 70 }, undefined],
  ["starts fresh for a target in a turn", { inTurn: true, lastSessionId: "sdk-1", sameSdk: true, occupancyPct: 40 }, undefined],
  ["starts fresh for a Codex session", { inTurn: false, lastSessionId: "thr-1", sameSdk: false, occupancyPct: 40 }, undefined],
  ["starts fresh when there is no saved session", { inTurn: false, sameSdk: true, occupancyPct: 40 }, undefined],
];
for (const [what, facts, forkFrom] of FORKS) {
  test(`fork vs fresh: ${what}`, async () => {
    const seen: string[] = [];
    const r = rig({ deps: { forkFacts: (folder) => (seen.push(folder), facts) } });
    await r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
    expect(seen).toEqual([join(r.root, "eticket-v3")]);
    expect(r.consult.jobs[0]!.forkFrom).toBe(forkFrom);
  });
}

// Criterion 4
test("an answer in time is the tool result; the row is answered with answer and delivered_at set, and one note_answered event", async () => {
  const r = rig();
  const text = await r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  const [row] = questions(r.ledger, "eticket-v3");
  expect(text).toBe(`answer from eticket-v3 (note #${row!.id}):\nUse the ScaleDown card: tools_for scaledown.`);
  expect(row!.answer).toBe("Use the ScaleDown card: tools_for scaledown.");
  expect(row!.resolvedAt).toBe(1_000_000);
  expect(row!.deliveredAt).toBe(1_000_000);
  expect(JSON.parse(row!.resolution!)).toMatchObject({ how: "answered", by: "eticket-v3" });
  const ans = events(r.ledger, "note_answered");
  expect(ans).toHaveLength(1);
  expect(JSON.stringify(ans[0])).not.toContain("ScaleDown card");
  expect(r.lines.some((l) => l.text === `↩ eticket-v3 answered note #${row!.id} in 0s`)).toBe(true);
  expect(r.live).toEqual([]); // delivered in the result: nothing held
});

test("an answer over answerMaxChars is cut", async () => {
  const r = rig({ questions: { answerMaxChars: 50 }, auto: { ok: true, answer: "a".repeat(200) } });
  await r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  expect(questions(r.ledger, "eticket-v3")[0]!.answer!.length).toBeLessThanOrEqual(50);
});

test("a secret-looking answer gives the withheld line, and the sentinel appears in no row, event, trace line or reply", async () => {
  const SENTINEL = "SENTINEL" + "s3cr3tValue9";
  const r = rig({ auto: { ok: true, answer: `Log in with API_KEY=${SENTINEL} and go.` } });
  const text = await r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "resource" }, 1_000_000);
  expect(text).toContain("[answer withheld: it looked like a secret (assignment)");
  expect(text).not.toContain(SENTINEL);
  const everything = JSON.stringify({
    rows: r.ledger.attentionRows("eticket-v3", "note"),
    events: r.ledger.listEvents({ limit: 200 }),
    lines: r.lines,
    live: r.notes.takeLive("s-prod", join(r.root, "prod-ops"), 1_000_001),
  });
  expect(everything).not.toContain(SENTINEL);
  expect(questions(r.ledger, "eticket-v3")[0]!.answer).toContain("answer withheld");
});

test("a late answer that looks like a secret is withheld too, in the live frame", async () => {
  const SENTINEL = "SENTINEL" + "lateValue77";
  const r = rig({ auto: null });
  const res = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  r.clock.fireAll();
  await res;
  r.consult.pending[0]!.resolve({ ok: true, answer: `token: ${SENTINEL}` });
  await flush();
  const frame = r.notes.takeLive("s-prod", join(r.root, "prod-ops"), 1_000_500);
  expect(frame).toContain("answer withheld");
  expect(JSON.stringify({ frame, rows: r.ledger.attentionRows("eticket-v3", "note"), ev: r.ledger.listEvents({ limit: 200 }), lines: r.lines })).not.toContain(SENTINEL);
});

// Criterion 5
test("a late answer: the next-step text at answerWaitMs, then held and delivered once", async () => {
  const r = rig({ auto: null });
  const res = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  expect(r.clock.armed.map((t) => t.ms)).toEqual([240_000]);
  r.clock.fireAll();
  const text = await res;
  const [row] = questions(r.ledger, "eticket-v3");
  expect(text).toBe(
    `No answer yet (note #${row!.id}). It will reach you at your next step. Continue other work; if you are blocked, check-point and raise ask_operator.`,
  );
  expect(row!.resolvedAt).toBeUndefined();
  expect(r.notes.takeLive("s-prod", join(r.root, "prod-ops"), 1_100_000)).toBe(""); // nothing yet
  r.setNow(1_300_000);
  r.consult.pending[0]!.resolve({ ok: true, answer: "It lives in the relay." });
  await flush();
  const after = r.ledger.attentionById(row!.id)!;
  expect(after.answer).toBe("It lives in the relay.");
  expect(after.resolvedAt).toBe(1_300_000);
  expect(after.deliveredAt).toBeUndefined();
  expect(r.live).toEqual([join(r.root, "prod-ops")]); // the delivery callback (T8: followUp steer if in a turn)
  expect(r.lines.some((l) => l.text === `↩ eticket-v3 answered note #${row!.id} in 300s`)).toBe(true);
  const frame = r.notes.takeLive("s-prod", join(r.root, "prod-ops"), 1_300_001);
  expect(frame).toContain(`• answer to note #${row!.id} from eticket-v3: It lives in the relay.`);
  expect(r.ledger.attentionById(row!.id)!.deliveredAt).toBe(1_300_001);
  expect(r.notes.takeLive("s-prod", join(r.root, "prod-ops"), 1_300_002)).toBe("");
});

test("a consult that finishes in time with no answer: resolved not_needed with the reason; the asker is told to raise ask_operator", async () => {
  const r = rig({ auto: { ok: false, answer: "", reason: "stalled" } });
  const text = await r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  const [row] = questions(r.ledger, "eticket-v3");
  expect(text).toBe(`no answer from eticket-v3 (note #${row!.id}): stalled. Raise ask_operator if you are blocked.`);
  expect(JSON.parse(row!.resolution!)).toMatchObject({ how: "not_needed", reason: "no answer: stalled" });
  expect(row!.deliveredAt).toBe(1_000_000);
  // An empty answer counts as no answer.
  const r2 = rig({ auto: { ok: true, answer: "  " } });
  expect(await r2.notes.ask(prodOps(r2.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000)).toMatch(/no answer from eticket-v3 .*: empty answer/);
});

test("a note withdrawn while its consult ran is not overwritten by the late answer", async () => {
  const r = rig({ auto: null });
  const res = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  r.clock.fireAll();
  await res;
  const [row] = questions(r.ledger, "eticket-v3");
  r.notes.withdraw("prod-ops", row!.id, 1_000_100);
  r.consult.pending[0]!.resolve({ ok: true, answer: "late" });
  await flush();
  const after = r.ledger.attentionById(row!.id)!;
  expect(JSON.parse(after.resolution!).how).toBe("withdrawn");
  expect(after.answer).toBeUndefined();
  expect(r.notes.takeLive("s-prod", join(r.root, "prod-ops"), 1_000_200)).toBe("");
});

// Criterion 6
test("blockedOn {kind:agent} is set during the wait and cleared on success", async () => {
  const r = rig({ auto: null });
  const res = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  expect(r.blocked).toEqual([{ sid: "s-prod", on: { kind: "agent", label: "asked eticket-v3", since: 1_000_000 } }]);
  r.consult.pending[0]!.resolve({ ok: true, answer: "yes" });
  await res;
  expect(r.blocked.at(-1)).toEqual({ sid: "s-prod", on: undefined });
  expect(r.blocked).toHaveLength(2);
  expect(r.clock.armed[0]!.cancelled).toBe(true);
});

test("blockedOn is cleared at the answer wait's end (timeout)", async () => {
  const r = rig({ auto: null });
  const res = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  r.clock.fireAll();
  await res;
  expect(r.blocked.map((b) => b.on?.kind)).toEqual(["agent", undefined]);
  r.consult.pending[0]!.resolve({ ok: true, answer: "late" });
  await flush();
  expect(r.blocked).toHaveLength(2); // the late settle blocks nothing
});

test("blockedOn is cleared when the consult throws, and the question fails with the reason", async () => {
  const r = rig({ auto: null });
  const res = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  r.consult.pending[0]!.reject(new Error("worker crashed"));
  const text = await res;
  expect(text).toMatch(/no answer from eticket-v3 \(note #\d+\): worker crashed\. Raise ask_operator/);
  expect(r.blocked.map((b) => b.on?.kind)).toEqual(["agent", undefined]);
  expect(JSON.parse(questions(r.ledger, "eticket-v3")[0]!.resolution!).reason).toBe("no answer: worker crashed");
});

// Criterion 9
test("who takes: an answer for a live from_session goes only to it; once it ends, another session of the folder takes it once", async () => {
  const liveSet = new Set(["s-prod"]);
  const r = rig({ auto: null, deps: { liveSession: (id) => liveSet.has(id) } });
  const res = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  r.clock.fireAll();
  await res;
  r.consult.pending[0]!.resolve({ ok: true, answer: "the answer" });
  await flush();
  const folder = join(r.root, "prod-ops");
  expect(r.notes.takeLive("s-other", folder, 1_000_100)).toBe("");
  liveSet.delete("s-prod");
  expect(r.notes.takeLive("s-other", folder, 1_000_200)).toContain("the answer");
  expect(r.notes.takeLive("s-other", folder, 1_000_300)).toBe("");
  expect(r.notes.takeLive("s-prod", folder, 1_000_400)).toBe("");
});

// Criterion 12
test("sweepQuestions at boot: an answering question resolves as no answer: reload, and the failure line is held for the sender", async () => {
  const r = rig({ auto: null });
  const res = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  r.clock.fireAll();
  await res;
  const [row] = questions(r.ledger, "eticket-v3");
  // The tick in the same engine never fails a question whose consult is still running.
  r.notes.sweepQuestions(1_000_100);
  expect(r.ledger.attentionById(row!.id)!.resolvedAt).toBeUndefined();
  // A reload: a new engine on the same ledger.
  const booted = createProjectNotes({ ...r.deps });
  booted.sweepQuestions(2_000_000);
  const after = r.ledger.attentionById(row!.id)!;
  expect(JSON.parse(after.resolution!)).toMatchObject({ how: "not_needed", reason: "no answer: reload" });
  expect(after.deliveredAt).toBeUndefined();
  expect(booted.takeLive("s-new", join(r.root, "prod-ops"), 2_000_001)).toContain(`• no answer to note #${row!.id} from eticket-v3: reload`);
});

test("sweepQuestions: a held answer older than live.holdMaxMs is not delivered live any more, and stays on the note", async () => {
  const r = rig({ auto: null, deps: {} });
  const res = r.notes.ask(prodOps(r.root), { to: "eticket-v3", question: Q, need: "info" }, 1_000_000);
  await flush();
  r.clock.fireAll();
  await res;
  r.consult.pending[0]!.resolve({ ok: true, answer: "old answer" });
  await flush();
  const [row] = questions(r.ledger, "eticket-v3");
  r.notes.sweepQuestions(1_000_000 + DEFAULT_NOTES_CFG.live.holdMaxMs - 1);
  expect(r.ledger.attentionById(row!.id)!.deliveredAt).toBeUndefined(); // not yet
  r.notes.sweepQuestions(1_000_000 + DEFAULT_NOTES_CFG.live.holdMaxMs + 1);
  expect(r.notes.takeLive("s-prod", join(r.root, "prod-ops"), 1_000_000 + DEFAULT_NOTES_CFG.live.holdMaxMs + 2)).toBe("");
  expect(r.ledger.attentionById(row!.id)!.answer).toBe("old answer");
  expect(r.notes.show("prod-ops", row!.id)!.state).toBe("answered");
});
