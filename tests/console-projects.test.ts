// P6 Task 6.2 on the web console: the Projects tab reads /api/projects and /api/projects/:name, its
// attention buttons reuse the one attention action path, every string is a catalogue key (EN + AR),
// and refs/shas render as attached LTR runs.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";
import { consolePage } from "../src/frontends/web";

const APP = readFileSync(join(import.meta.dir, "../src/frontends/web/app.ts"), "utf8");
const fn = (name: string): string => {
  const m = APP.match(new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}\\n`));
  if (!m) throw new Error(`no function ${name} in app.ts`);
  return m[0];
};
const has = (cat: Record<string, unknown>, key: string): boolean => {
  let o: unknown = cat;
  for (const k of key.split(".")) o = (o as Record<string, unknown> | undefined)?.[k];
  return typeof o === "string" && o.trim().length > 0;
};

test("the shell has a Projects tab and its view; the module loads the list and one project", () => {
  const html = consolePage({ lang: "en" });
  expect(html).toContain('data-v="projects" data-i18n="tabs.projects"');
  expect(html).toContain('id="vprojects"');
  expect(APP).toContain('"/api/projects"');
  expect(APP).toContain("`/api/projects/${encodeURIComponent(name)}`");
  expect(APP).toMatch(/const VIEWS = \[[^\]]*"projects"/);
});

test("attention buttons: one shared helper — the feed's /attention list and the project pane both use it", () => {
  expect(APP.match(/post\("\/api\/attention"/g)!.length).toBe(1);
  expect(fn("attentionButtons")).toContain("x.drop");
  expect(fn("renderAttention")).toContain("attentionButtons(");
  expect(fn("renderProjectPane")).toContain("attentionButtons(");
});

test("the pane: every section of the sketch, threads open in the Threads tab, refs and shas as LTR runs", () => {
  const pane = fn("renderProjectPane");
  for (const s of ["now", "queue", "git", "github", "decide", "plans", "attention", "threads", "restart"]) expect(pane).toContain(`pj.sect.${s}`);
  for (const k of ["noUpstream", "undeployed", "error", "fileMissing", "scanned", "never"]) expect(pane).toContain(k);
  expect(pane).toContain("threadChip(");
  expect(fn("threadChip")).toContain('data-act="project-thread"');
  expect(APP).toContain('case "project-thread"');
  expect(pane).toContain("ltr(sha)");
  expect(pane).toContain("ltr(d.ref)");
});

test("every pj.* key and enum family is in both catalogues (real Arabic, not English copies)", () => {
  const families = [
    ...["ok", "attention", "down", "unknown"].map((s) => `pj.health.${s}`),
    ...["starting", "working", "quiet", "idle", "awaiting-operator", "wedged"].map((s) => `pj.state.${s}`),
    ...["high", "normal", "low"].map((s) => `pj.sev.${s}`),
    ...["now", "queue", "git", "github", "decide", "plans", "attention", "threads", "restart"].map((s) => `pj.sect.${s}`),
    "tabs.projects",
  ];
  const used = [...APP.matchAll(/\btx?\("(pj\.[a-zA-Z0-9.-]+)"/g)].map((m) => m[1]!);
  expect(used.length).toBeGreaterThan(20);
  for (const k of [...families, ...used]) {
    expect(has(en, k), `en ${k}`).toBe(true);
    expect(has(ar, k), `ar ${k}`).toBe(true);
    if (!/^pj\.(health|sev)\./.test(k)) expect(/[؀-ۿ]/.test(String(k.split(".").reduce((o: any, p) => o[p], ar))), `ar ${k} is Arabic`).toBe(true);
  }
});

test("a console link #project=<name> opens that project's dashboard", () => {
  expect(APP).toContain("#project=");
});
