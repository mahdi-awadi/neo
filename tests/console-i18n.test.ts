// The console speaks Arabic and English from standard catalogues (engineering baseline, AC3.5):
// src/frontends/web/locales/{en,ar}/console.json through i18next, no literal user-facing strings in
// the client or the page shell, RTL for Arabic with refs and numbers as attached LTR runs.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { createHash, createHmac } from "node:crypto";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";
import { consolePage, createWebApp, loginPage } from "../src/frontends/web";
import { createConsoleI18n } from "../src/frontends/web/i18n";
import { loadConfig } from "../src/config";
import { openLedger } from "../src/engine/ledger";
import { openAdminStore } from "../src/engine/admin";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { createSessionStore } from "../src/engine/web-session";
import { openTrustStore } from "../src/engine/trust";

const WEB = join(import.meta.dir, "../src/frontends/web");
const APP = readFileSync(join(WEB, "app.ts"), "utf8");
const SHELL = readFileSync(join(WEB, "index.html"), "utf8");
const LOGIN = readFileSync(join(WEB, "login.html"), "utf8");

/** Every leaf key of a catalogue as a dotted path, with its text. */
function leaves(o: Record<string, unknown>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") for (const [kk, vv] of leaves(v as Record<string, unknown>, key)) out.set(kk, vv);
    else out.set(key, String(v));
  }
  return out;
}
const EN = leaves(en);
const AR = leaves(ar);
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

test("catalogue parity: every key in en is in ar and the reverse, none empty, same placeholders", () => {
  expect([...AR.keys()].sort()).toEqual([...EN.keys()].sort());
  for (const [k, v] of EN) {
    expect(v.trim().length, k).toBeGreaterThan(0);
    expect(AR.get(k)!.trim().length, k).toBeGreaterThan(0);
    expect(placeholders(AR.get(k)!), k).toEqual(placeholders(v));
  }
});

test("every key the module and the page shell use exists in the catalogue", () => {
  const used = new Set<string>();
  for (const m of APP.matchAll(/\btx?\("([a-zA-Z0-9.-]+)"/g)) used.add(m[1]!);
  for (const m of SHELL.matchAll(/data-i18n(?:-placeholder|-title)?="([a-zA-Z0-9.-]+)"/g)) used.add(m[1]!);
  expect(used.size).toBeGreaterThan(60);
  for (const k of used) expect(EN.has(k), k).toBe(true);
  // Keys built from data (`threads.state.${...}`) are covered by their families existing in full.
  for (const s of ["open", "waiting", "done", "failed"]) expect(EN.has(`threads.state.${s}`)).toBe(true);
  for (const s of ["new", "with-agent", "drafted", "replied"]) expect(EN.has(`inbox.status.${s}`)).toBe(true);
  for (const s of ["handoff", "clear", "deferred", "resumed", "fresh"]) expect(EN.has(`recent.verdict.${s}`)).toBe(true);
  for (const s of ["draft", "sent", "approved", "executing", "done", "abandoned"]) expect(EN.has(`threads.planStatus.${s}`)).toBe(true);
});

/** Text that a person reads: a letter (Latin or Arabic) outside markup. */
const LETTER = /[A-Za-z؀-ۿ]{2,}/;

/** Every string and template literal in app.ts (the TypeScript parser, so comments and regexes never
 *  read as strings), with the code around it. Template slots `${…}` are not part of the text. */
function literals(src: string): Array<{ text: string; node: ts.Node }> {
  const sf = ts.createSourceFile("app.ts", src, ts.ScriptTarget.Latest, true);
  const out: Array<{ text: string; node: ts.Node }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ text: n.text, node: n });
    else if (ts.isTemplateExpression(n)) out.push({ text: [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("\u0000"), node: n });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The literal user-facing strings in a client source. */
function literalText(src: string): string[] {
  const offenders: string[] = [];
  for (const { text, node } of literals(src)) {
    // A text node inside markup: `>Some words<`.
    for (const m of text.matchAll(/>([^<>\u0000]*)</g)) if (LETTER.test(m[1]!)) offenders.push(text);
    // A plain-text sink fed a literal: el.textContent / title / placeholder = "…", alert("…"), confirm("…").
    const p = node.parent;
    const sink =
      (ts.isBinaryExpression(p) && p.right === node && ts.isPropertyAccessExpression(p.left) && ["textContent", "title", "placeholder"].includes(p.left.name.text)) ||
      (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && ["alert", "confirm"].includes(p.expression.text));
    if (sink && LETTER.test(text)) offenders.push(text);
  }
  return offenders;
}

test("no literal user-facing strings in the client module: text nodes and dialog/label text come from t()", () => {
  expect(literalText(APP)).toEqual([]);
  // The check itself catches each kind (and ignores comments, regexes and code-only strings).
  const bad = `// it's fine\nconst r = /[&<>"]/g;\nel.textContent = "Hello there";\nalert("Send failed.");\nh += '<div class="x">Nothing yet</div>';\nh += \`<b>\${t("k")}</b>\`;\nb.className = "chip ok";`;
  expect(literalText(bad)).toEqual(["Hello there", "Send failed.", '<div class="x">Nothing yet</div>']);
});

test("no literal user-facing text in the page shells, apart from the brand", () => {
  for (const html of [SHELL, LOGIN]) {
    const body = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
    const text = [...body.matchAll(/>([^<>]+)</g)].map((m) => m[1]!.trim()).filter((s) => LETTER.test(s) && !/^%[A-Z_]+%$/.test(s));
    expect(text).toEqual(["NEO"]);
    expect(/\splaceholder="[^"%]/.test(body)).toBe(false);
  }
});

test("Arabic pages are right-to-left; English pages left-to-right", () => {
  expect(consolePage({ lang: "ar" })).toContain('<html lang="ar" dir="rtl"');
  expect(consolePage({ lang: "en" })).toContain('<html lang="en" dir="ltr"');
  expect(loginPage("neo_bot", "ar")).toContain('<html lang="ar" dir="rtl">');
  expect(loginPage("neo_bot", "ar")).toContain(createConsoleI18n("ar").t("login.sub"));
});

test("refs, paths, ids and times render as isolated LTR runs (<bdi dir=\"ltr\">)", () => {
  expect(APP).toMatch(/function ltr\(s: unknown\): string \{\n\s+return `<bdi dir="ltr" class="ref">\$\{esc\(s\)\}<\/bdi>`;/);
  for (const use of ["ltr(r.ref)", "ltr(th.ref)", "ltr(p.folder)", "ltr(clock(m.at))", 'ltr("#" + x.id)']) expect(APP).toContain(use);
  // Dates and times keep Latin digits, like every other number on the page.
  expect(APP).toContain("-u-nu-latn");
});

test("the language: the operator's cookie wins, else config consoleLang; /app.js is served behind the session", async () => {
  const TOKEN = "123456:TESTTOKEN";
  const login = (): string => {
    const data: Record<string, string> = { id: "555", auth_date: "1000" };
    const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
    data.hash = createHmac("sha256", createHash("sha256").update(TOKEN).digest()).update(dcs).digest("hex");
    return `http://neo.test/auth/telegram?${new URLSearchParams(data).toString()}`;
  };
  const app = (consoleLang: "en" | "ar") =>
    createWebApp({
      engine: { cfg: { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-i18n-"))), telegramToken: TOKEN, consoleLang }, ledger: openLedger(":memory:"), registry: createRegistry(), meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:") },
      botToken: TOKEN,
      botUsername: "neo_bot",
      sessions: createSessionStore({ secret: "s", ttlSec: 100000 }),
      admin: openAdminStore(":memory:"),
      now: () => 1000,
    });
  const a = app("ar");
  const cookie = (await a.fetch(new Request(login()))).headers.get("set-cookie")!.split(";")[0]!;
  const page = (c: string) => a.fetch(new Request("http://neo.test/", { headers: { cookie: c } })).then((r) => r.text());
  expect(await page(cookie)).toContain('dir="rtl"');
  expect(await page(`${cookie}; neo_lang=en`)).toContain('dir="ltr"');
  expect(await page(`${cookie}; neo_lang=xx`)).toContain('dir="rtl"');
  expect(await (await a.fetch(new Request("http://neo.test/"))).text()).toContain('lang="ar"'); // the login page too
  expect((await a.fetch(new Request("http://neo.test/app.js"))).status).toBe(401);
  const js = await a.fetch(new Request("http://neo.test/app.js", { headers: { cookie } }));
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("javascript");
  expect(loadConfig(mkdtempSync(join(tmpdir(), "neo-i18n-"))).consoleLang).toBe("en");
});
