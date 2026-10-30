// The console's History tab (ADR-0066, plan task 13, AC18): GET /api/history, POST /api/history/remember and
// POST /api/history/forget behind the session with every field checked; the panel's hit cards, mode
// banner and states rendered from the catalogues with ids, dates, shas and counts as LTR isolates; the
// forget confirm with a reason; the filters folded at phone width.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac } from "node:crypto";
import { createWebApp } from "../src/frontends/web";
import { createConsoleI18n } from "../src/frontends/web/i18n";
import { ERROR_CODES, OFF_REASONS, QUERY_KINDS, VIA, errorText, forgetToast, hitCard, historyQuery, modeBanner, resultsHtml, type Fmt, type HitView } from "../src/frontends/web/history";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { createSessionStore } from "../src/engine/web-session";
import { openTrustStore } from "../src/engine/trust";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../src/engine/format";
import type { ForgetResult, HistoryQuery, HistoryResult, RememberInput, RememberResult, TaskHistory } from "../src/engine/history/index";

const WEB = join(import.meta.dir, "../src/frontends/web");
const APP = readFileSync(join(WEB, "app.ts"), "utf8");
const PANEL = readFileSync(join(WEB, "history.ts"), "utf8");
const SHELL = readFileSync(join(WEB, "index.html"), "utf8");
const CSS = SHELL.match(/<style>([\s\S]*?)<\/style>/)![1]!;
const TOKEN = "123456:TESTTOKEN";

// ── the API ──────────────────────────────────────────────────────────────────────────────────────
interface Fake extends TaskHistory {
  queries: HistoryQuery[];
  saved: RememberInput[];
  forgot: Array<{ ref: string; reason: string }>;
  next?: HistoryResult;
}

function fakeHistory(): Fake {
  const f: Fake = {
    queries: [], saved: [], forgot: [],
    async search(q) {
      f.queries.push(q);
      return f.next ?? {
        ok: true, mode: { meaning: "partial", coverage: 0.42 },
        hits: [{ ref: "todo:884", kind: "todo", project: "gold", at: Date.UTC(2026, 9, 20), title: "bus <b>seats</b>", snippet: `the ${SNIPPET_OPEN}seats${SNIPPET_CLOSE} <script>`, todo: 884, commits: ["479236d"], archived: false, via: ["exact", "words"] }],
      };
    },
    remember(e): RememberResult {
      f.saved.push(e);
      if (e.text.trim().length < 10) return { ok: false, error: "too_short" };
      return { ok: true, ref: "mem:3", duplicate: false };
    },
    async indexTick() {
      return {} as never;
    },
    async forget(ref, reason): Promise<ForgetResult> {
      f.forgot.push({ ref, reason });
      if (ref === "todo:1") return { ok: false, error: "unknown_ref", chunks: 0, points: 0, pendingPoints: 0 };
      return { ok: true, chunks: 3, points: 2, pendingPoints: 1 };
    },
    status: () => ({}) as never,
    close() {},
  };
  return f;
}

async function rig(history: TaskHistory | undefined = fakeHistory()) {
  const app = createWebApp({
    engine: { cfg: { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-hist-"))), telegramToken: TOKEN }, ledger: openLedger(":memory:"), registry: createRegistry(), meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"), ...(history ? { history } : {}) },
    botToken: TOKEN, botUsername: "neo_bot", sessions: createSessionStore({ secret: "s", ttlSec: 100000 }), admin: openAdminStore(":memory:"), now: () => 1000,
  });
  const data: Record<string, string> = { id: "555", auth_date: "1000" };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  data.hash = createHmac("sha256", createHash("sha256").update(TOKEN).digest()).update(dcs).digest("hex");
  const cookie = (await app.fetch(new Request(`http://neo.test/auth/telegram?${new URLSearchParams(data)}`))).headers.get("set-cookie")!.split(";")[0]!;
  const get = (qs: string, c = cookie) => app.fetch(new Request(`http://neo.test/api/history?${qs}`, { headers: { cookie: c } }));
  const post = (path: string, body: unknown, c = cookie) =>
    app.fetch(new Request(`http://neo.test/api/history/${path}`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { get, post };
}

const json = async (r: Response) => ({ status: r.status, cache: r.headers.get("cache-control"), body: (await r.json()) as Record<string, any> });

test("no session: every history route answers 401", async () => {
  const r = await rig();
  expect((await r.get("q=x", "")).status).toBe(401);
  expect((await r.post("remember", { text: "a fact worth keeping" }, "")).status).toBe(401);
  expect((await r.post("forget", { ref: "todo:2", reason: "x" }, "")).status).toBe(401);
});

test("GET /api/history: each bad field is a 400 with its reason, no-store, and the seam is not asked", async () => {
  const h = fakeHistory();
  const r = await rig(h);
  const cases: Array<[string, string]> = [
    ["q=", "query_empty"],
    ["q=%20%20", "query_empty"],
    [`q=${"a".repeat(501)}`, "query_too_long"],
    ["q=x&kinds=todo,bogus", "unknown_kind"],
    ["q=x&since=2026-13-01", "bad_date"],
    ["q=x&until=yesterday", "bad_date"],
    ["q=x&since=2026-10-20&until=2026-10-01", "bad_range"],
    ["q=x&limit=ten", "bad_limit"],
    ["q=x&limit=-1", "bad_limit"],
    [`q=x&project=${"p".repeat(200)}`, "bad_project"],
    ["q=x&project=..%2Fetc", "bad_project"],
  ];
  for (const [qs, error] of cases) {
    const res = await json(await r.get(qs));
    expect([qs, res.status, res.body.error]).toEqual([qs, 400, error]);
    expect(res.cache).toBe("no-store");
  }
  expect(h.queries).toEqual([]);
});

test("GET /api/history: the fields reach the seam (dates as UTC days, the limit clamped); the snippet is safe HTML", async () => {
  const h = fakeHistory();
  const r = await rig(h);
  const res = await json(await r.get("q=bus+seats&project=gold&kinds=todo,line&since=2026-10-01&until=2026-10-31&limit=999"));
  expect(res.status).toBe(200);
  expect(res.cache).toBe("no-store");
  expect(h.queries[0]).toEqual({ query: "bus seats", project: "gold", kinds: ["todo", "line"], since: Date.UTC(2026, 9, 1), until: Date.UTC(2026, 9, 31) + 86_399_999, limit: 50 });
  expect(res.body.mode).toEqual({ meaning: "partial", coverage: 0.42 });
  expect(res.body.hits[0].snippet).toBe("the <mark>seats</mark> &lt;script&gt;");
  expect(res.body.hits[0].title).toBe("bus <b>seats</b>"); // the client escapes it
  await r.get("q=x&limit=0");
  expect(h.queries[1]!.limit).toBe(1);
  await r.get("q=x");
  expect(h.queries[2]).toEqual({ query: "x" });
});

test("GET /api/history: the seam's refusal is a 400, an unreadable store a 503, history off a 503", async () => {
  const h = fakeHistory();
  const r = await rig(h);
  h.next = { ok: false, error: "query_stopwords", hits: [], mode: { meaning: "skipped" } };
  expect(await json(await r.get("q=the"))).toMatchObject({ status: 400, body: { ok: false, error: "query_stopwords" } });
  h.next = { ok: false, error: "history_unreadable", hits: [], mode: { meaning: "skipped" } };
  expect(await json(await r.get("q=x"))).toMatchObject({ status: 503, body: { error: "history_unreadable" } });
  const off = await rig(null as never);
  expect(await json(await off.get("q=x"))).toMatchObject({ status: 503, cache: "no-store", body: { error: "history_off" } });
  expect(await json(await off.post("remember", { text: "a fact worth keeping" }))).toMatchObject({ status: 503, body: { error: "history_off" } });
});

test("POST /api/history/remember: the operator saves; text is required; a refusal is a 400 with its reason", async () => {
  const h = fakeHistory();
  const r = await rig(h);
  expect(await json(await r.post("remember", { text: "the gold fees live in config", project: " gold " }))).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, ref: "mem:3", duplicate: false } });
  expect(h.saved[0]).toEqual({ text: "the gold fees live in config", project: "gold", by: "operator", session: "console" });
  expect(await json(await r.post("remember", { text: 42 }))).toMatchObject({ status: 400, body: { error: "text_required" } });
  expect(await json(await r.post("remember", { text: "a fact worth keeping", project: 7 }))).toMatchObject({ status: 400, body: { error: "bad_project" } });
  expect(await json(await r.post("remember", { text: "short" }))).toMatchObject({ status: 400, body: { error: "too_short" } });
  expect(h.saved.length).toBe(2);
});

test("POST /api/history/forget: a reason is required; the answer has the counts; an unknown ref is a 404", async () => {
  const h = fakeHistory();
  const r = await rig(h);
  expect(await json(await r.post("forget", { ref: "todo:2" }))).toMatchObject({ status: 400, body: { error: "reason_required" } });
  expect(await json(await r.post("forget", { ref: "todo:2", reason: "   " }))).toMatchObject({ status: 400, body: { error: "reason_required" } });
  expect(await json(await r.post("forget", { ref: 2, reason: "x" }))).toMatchObject({ status: 400, body: { error: "bad_ref" } });
  expect(await json(await r.post("forget", { ref: "todo:2", reason: "r".repeat(501) }))).toMatchObject({ status: 400, body: { error: "reason_too_long" } });
  expect(h.forgot).toEqual([]);
  expect(await json(await r.post("forget", { ref: "todo:2", reason: " wrong customer " }))).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, chunks: 3, points: 2, pendingPoints: 1 } });
  expect(h.forgot).toEqual([{ ref: "todo:2", reason: "wrong customer" }]);
  expect(await json(await r.post("forget", { ref: "todo:1", reason: "x" }))).toMatchObject({ status: 404, body: { error: "unknown_ref" } });
});

test("the history routes take only their methods and paths", async () => {
  const r = await rig();
  expect((await r.post("search", {})).status).toBe(404);
  expect((await r.get("q=x")).status).toBe(200);
});

// ── the panel ────────────────────────────────────────────────────────────────────────────────────
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function fmt(lang: "en" | "ar"): Fmt {
  const i = createConsoleI18n(lang);
  return {
    esc, ltr: (s) => `<bdi dir="ltr" class="ref">${esc(s)}</bdi>`, iso: (s) => `<bdi>${esc(s)}</bdi>`,
    t: (k, v) => i.t(k, v ?? {}), tx: (k, v) => i.t(k, { ...v, interpolation: { escapeValue: false } }),
    date: (at) => new Date(at).toISOString().slice(0, 10),
  };
}
const HIT: HitView = {
  ref: "plan:12", kind: "plan", project: "gold", at: Date.UTC(2026, 9, 20), title: "Fees <img src=x onerror=alert(1)>",
  snippet: "the <mark>fees</mark>", todo: 884, thread: 991, path: "/home/gold/docs/plan.md", commits: ["479236d"], archived: true, via: ["exact", "meaning"], alsoIn: ["todo:9"],
};

test("a hit card has every field: kind, archived, project, date, ref, title, snippet, via, commits, plan link, the source and Forget", () => {
  const h = hitCard(HIT, fmt("en"));
  expect(h).toContain('<span class="tchip hk">Plan</span>');
  expect(h).toContain(">archived<");
  expect(h).toContain("<bdi>gold</bdi>");
  expect(h).toContain('<bdi dir="ltr" class="ref">2026-10-20</bdi>');
  expect(h).toContain('<bdi dir="ltr" class="ref">plan:12</bdi>');
  expect(h).toContain("Fees &lt;img src=x onerror=alert(1)&gt;");
  expect(h).not.toContain("<img");
  expect(h).toContain('<div class="hsn" dir="auto">the <mark>fees</mark></div>');
  expect(h).toContain(">id<");
  expect(h).toContain(">meaning<");
  expect(h).toContain('Commits <bdi dir="ltr" class="ref">479236d</bdi>');
  expect(h).toContain('href="/md-file?path=%2Fhome%2Fgold%2Fdocs%2Fplan.md"');
  expect(h).toContain('Also in <bdi dir="ltr" class="ref">todo:9</bdi>');
  expect(h).toContain('data-act="todo-open" data-id="884"');
  expect(h).toContain('<bdi dir="ltr" class="ref">#884</bdi>');
  expect(h).toContain('data-act="project-thread" data-id="991"');
  expect(h).toContain('data-act="history-forget" data-ref="plan:12"');
  // A worker line lives in the ledger: no Forget.
  expect(hitCard({ ...HIT, ref: "line:5", kind: "line" }, fmt("en"))).not.toContain("history-forget");
  // A value the client does not know is shown, escaped, never trusted as a key.
  expect(hitCard({ ...HIT, kind: '"><x>', via: ["<y>"] }, fmt("en"))).not.toMatch(/<x>|<y>/);
});

test("the mode banner: nothing when on; partial with its share, off with the reason, skipped — each from the catalogue", () => {
  const f = fmt("en");
  expect(modeBanner({ meaning: "on" }, f)).toBe("");
  expect(modeBanner({ meaning: "partial", coverage: 0.426 }, f)).toContain('covers <bdi dir="ltr" class="ref">42%</bdi> of the history');
  expect(modeBanner({ meaning: "off", reason: "embedder_down" }, f)).toContain("Meaning search is off (the embedder does not answer)");
  expect(modeBanner({ meaning: "off", reason: "<z>" }, f)).not.toContain("<z>");
  expect(modeBanner({ meaning: "skipped" }, f)).toContain("only ids");
  for (const m of ["partial", "off", "skipped"]) expect(modeBanner({ meaning: m, coverage: 0.5, reason: "vectors_down" } as never, f)).toContain('role="status"');
});

test("the states: the first hint, searching, an error with its reason, no hits, and the count of hits", () => {
  const f = fmt("en");
  expect(resultsHtml({ kind: "idle" }, f)).toContain("Search the todos");
  expect(resultsHtml({ kind: "loading" }, f)).toContain('aria-busy="true"');
  expect(resultsHtml({ kind: "error", code: "bad_range" }, f)).toContain("The start date is after the end date.");
  expect(resultsHtml({ kind: "error", code: "bad_range" }, f)).toContain('role="alert"');
  expect(resultsHtml({ kind: "error", code: "<b>odd</b>" }, f)).toContain("&lt;b&gt;odd");
  expect(resultsHtml({ kind: "done", mode: { meaning: "on" }, hits: [] }, f)).toContain("Nothing in the history matches.");
  const done = resultsHtml({ kind: "done", mode: { meaning: "skipped" }, hits: [HIT, HIT] }, f);
  expect(done).toContain('<bdi dir="ltr" class="ref">2</bdi> results');
  expect(done.indexOf("hbanner")).toBeLessThan(done.indexOf("hcard"));
  expect(errorText("secret: github token", f)).toBe("Not saved: it looks like a secret.");
  expect(forgetToast({ chunks: 3, points: 2, pendingPoints: 1 }, f)).toBe("Forgotten: 3 text parts and 2 vectors removed. 1 vectors wait for the shared index.");
});

test("in Arabic, ids, dates, shas and counts are LTR isolates, and numbers inside an Arabic snippet too", () => {
  const f = fmt("ar");
  const h = hitCard({ ...HIT, snippet: "حجز <mark>المقاعد</mark> 1,250 دينار" }, f);
  for (const v of ["plan:12", "2026-10-20", "479236d", "#884", "todo:9"]) expect(h).toContain(`<bdi dir="ltr" class="ref">${v}</bdi>`);
  expect(h).toContain('<bdi dir="ltr" class="n">1,250</bdi>');
  expect(h).toContain(">خطة<");
  expect(resultsHtml({ kind: "done", mode: { meaning: "partial", coverage: 0.5 }, hits: [HIT] }, f)).toContain('<bdi dir="ltr" class="ref">50%</bdi>');
  expect(resultsHtml({ kind: "done", mode: { meaning: "on" }, hits: [HIT] }, f)).toContain('<bdi dir="ltr" class="ref">1</bdi>');
});

test("the query string carries only the filled fields", () => {
  expect(historyQuery({ q: " seats ", project: "", kinds: [], since: "", until: "" })).toBe("q=seats");
  expect(historyQuery({ q: "x", project: "gold", kinds: ["todo", "plan"], since: "2026-10-01", until: "2026-10-31" })).toBe("q=x&project=gold&kinds=todo%2Cplan&since=2026-10-01&until=2026-10-31");
});

// ── the page ─────────────────────────────────────────────────────────────────────────────────────
/** One top-level function's source. */
function fn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf("\nfunction ", start + 1);
  const exp = src.indexOf("\nexport function ", start + 1);
  const end = [next, exp].filter((i) => i > -1).sort((a, b) => a - b)[0];
  return src.slice(start, end);
}

test("the tab, the view, the forget dialog and the wiring are on the page", () => {
  expect(SHELL).toContain('<button class="tab" data-v="history" data-i18n="tabs.history"></button>');
  expect(SHELL).toContain('<div class="view" id="vhistory">');
  expect(SHELL).toMatch(/<form class="hsearch" id="hform" role="search">/);
  expect(SHELL).toMatch(/<dialog class="sheet" id="hfsheet" aria-labelledby="hftitle">/);
  expect(SHELL).toContain('id="hfreason"');
  expect(SHELL).toContain('aria-controls="hfil"');
  expect(APP).toContain('"history"');
  expect(APP).toContain('case "history-forget":\n      return historyPanel.forget(el.dataset.ref ?? "");');
  expect(APP).toContain("mountHistory(");
  expect(APP).toMatch(/#\(project\|history\)=/);
});

test("Remember and Forget go through act() (busy + toast); Forget sends nothing without a reason", () => {
  const m = fn(PANEL, "mountHistory");
  expect(m).toContain('d.act($("hrsave"), "/api/history/remember"');
  expect(m).toContain('d.act($("hfgo"), "/api/history/forget", { ref, reason }');
  const go = m.slice(m.indexOf('$("hfgo").onclick'));
  expect(go.indexOf("if (!reason)")).toBeLessThan(go.indexOf("d.act("));
  expect(m).toContain("dlg.showModal()");
  // Each search cancels the one before it.
  expect(m).toContain("ctl?.abort()");
});

test("phone width: the filters fold behind one button, inputs do not zoom, cards wrap instead of scrolling sideways", () => {
  const at = CSS.indexOf("@media (max-width:768px){\n.hfbtn");
  expect(at).toBeGreaterThan(-1);
  const narrow = CSS.slice(at, CSS.indexOf("\n}\n", at));
  expect(narrow).toContain(".hfbtn{display:inline-flex}");
  expect(narrow).toContain(".hfil{display:none;grid-template-columns:minmax(0,1fr)}");
  expect(narrow).toContain(".hfil.open{display:grid}");
  expect(narrow).toMatch(/\.hsearch input[^{]*\{font-size:16px\}/);
  expect(CSS).toContain(".hfbtn{display:none}");
  expect(CSS).toMatch(/\.hcard\{[^}]*min-width:0;overflow-wrap:anywhere/);
  expect(CSS).toMatch(/\.hsearch\{[^}]*min-width:0/);
});

// ── the catalogues ───────────────────────────────────────────────────────────────────────────────
test("every history key the panel and the page use is in EN and AR, and the families are complete", () => {
  const used = new Set<string>();
  for (const m of PANEL.matchAll(/\btx?\("([a-zA-Z0-9._-]+)"/g)) used.add(m[1]!);
  for (const m of SHELL.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="(history\.[a-zA-Z0-9._-]+|tabs\.history)"/g)) used.add(m[1]!);
  for (const k of QUERY_KINDS) used.add(`history.kind.${k}`);
  for (const k of OFF_REASONS) used.add(`history.reason.${k}`);
  for (const k of ERROR_CODES) used.add(`history.error.${k}`);
  for (const k of VIA) used.add(`history.via.${k}`);
  expect(used.size).toBeGreaterThan(70);
  for (const lang of ["en", "ar"] as const) {
    const i = createConsoleI18n(lang);
    for (const k of used) expect(i.exists(k), `${lang}:${k}`).toBe(true);
  }
  // Arabic is translated, not copied.
  const ar = createConsoleI18n("ar");
  const en = createConsoleI18n("en");
  for (const k of ["tabs.history", "history.search", "history.forgetTitle", "history.kind.todo", "history.mode.off"]) expect(ar.t(k)).not.toBe(en.t(k));
});

test("the three new attention kinds have a name, a reason and a next step in EN and AR", () => {
  for (const lang of ["en", "ar"] as const) {
    const i = createConsoleI18n(lang);
    for (const kind of ["history_off", "history_degraded", "backup_failed"]) for (const part of ["kind", "why", "next"]) expect(i.exists(`att.${part}.${kind}`), `${lang}:${part}:${kind}`).toBe(true);
  }
});
