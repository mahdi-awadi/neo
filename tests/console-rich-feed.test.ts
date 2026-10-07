// The console's rich feed in the browser (spec 2026-10-07, ADR-0025): code blocks highlighted lazily
// with a copy button, rows coloured by tone, code and tables LTR in the Arabic UI. The highlighter is
// pure (web/code-blocks.ts); the DOM wiring and the stylesheet are checked at source level.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HIGHLIGHT_MAX, highlightHtml, resolveLang } from "../src/frontends/web/code-blocks";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";

const WEB = join(import.meta.dir, "../src/frontends/web");
const APP = readFileSync(join(WEB, "app.ts"), "utf8");
const CODE = readFileSync(join(WEB, "code-blocks.ts"), "utf8");
const CSS = readFileSync(join(WEB, "index.html"), "utf8").match(/<style>([\s\S]*?)<\/style>/)![1]!;

test("resolveLang: fence names and aliases map to a registered language; unknown → undefined", () => {
  expect(resolveLang("bash")).toBe("bash");
  expect(resolveLang("sh")).toBe("bash");
  expect(resolveLang("ts")).toBe("typescript");
  expect(resolveLang("tsx")).toBe("typescript");
  expect(resolveLang("yml")).toBe("yaml");
  expect(resolveLang("html")).toBe("xml");
  expect(resolveLang("diff")).toBe("diff");
  expect(resolveLang("Dockerfile")).toBe("dockerfile");
  expect(resolveLang("")).toBeUndefined();
  expect(resolveLang("cobol")).toBeUndefined();
});

test("highlightHtml: token spans over escaped text; diff lines get addition/deletion classes", () => {
  const sh = highlightHtml('echo "<x>" # note', "bash")!;
  expect(sh).toContain('<span class="hljs-built_in">echo</span>');
  expect(sh).toContain("&lt;x&gt;");
  expect(sh).toContain('<span class="hljs-comment"># note</span>');
  expect(sh).not.toContain("<x>");
  const diff = highlightHtml("-old\n+new", "diff")!;
  expect(diff).toContain('<span class="hljs-deletion">-old</span>');
  expect(diff).toContain('<span class="hljs-addition">+new</span>');
});

test("highlightHtml: no language, an unknown one, or an oversized block → undefined (stays plain)", () => {
  expect(highlightHtml("x", "")).toBeUndefined();
  expect(highlightHtml("x", "cobol")).toBeUndefined();
  expect(highlightHtml("a".repeat(HIGHLIGHT_MAX + 1), "bash")).toBeUndefined();
});

test("lazy: blocks are highlighted only when they scroll into view, once, then unobserved", () => {
  expect(CODE).toContain("new IntersectionObserver(");
  expect(CODE).toMatch(/unobserve\(/);
  expect(CODE).toContain("dataset.hl"); // a block is enhanced once
  // The feed, the open thread and an escalation card all hand their new nodes to the enhancer.
  expect(APP).toContain("enhanceCode(d)");
  expect(APP).toContain('enhanceCode($("tbody"))');
  expect(APP).toContain("enhanceCode(c)");
});

test("copy button: catalogue labels in EN and AR, clipboard with feedback, one delegated listener", () => {
  for (const cat of [en, ar] as Array<Record<string, any>>) {
    expect(cat.code.copy).toBeTruthy();
    expect(cat.code.copied).toBeTruthy();
    expect(cat.code.copyFailed).toBeTruthy();
  }
  expect(en.code.copy).not.toBe(ar.code.copy);
  expect(CODE).toContain("navigator.clipboard");
  expect(CODE).toContain('done("code.copied")');
  expect(CODE).toContain('done("code.copyFailed")');
  expect(CODE).toMatch(/addEventListener\("click"/);
});

test("rows carry their tone; thread history and escalations use the server's HTML", () => {
  expect(APP).toContain('(tone ? ` tone-${tone}` : "")'); // feed rows
  expect(APP).toContain('"out", e.project, e.tone)');
  expect(APP).toContain("html ?? m.html ?? esc(m.content)"); // thread history
  expect(APP).toContain("e.html ?? esc(e.reason)"); // escalation card
});

test("tones, syntax and diff colours exist in both themes", () => {
  for (const t of ["tool", "result", "error", "warn", "done", "approval", "info"]) expect(CSS).toContain(`.tone-${t}`);
  for (const v of ["--syn-kw", "--syn-str", "--syn-com", "--syn-num", "--syn-fn", "--syn-add", "--syn-del"]) {
    expect(CSS.match(new RegExp(`${v}:`, "g"))?.length).toBe(2); // dark + light
  }
  expect(CSS).toContain(".hljs-addition");
  expect(CSS).toContain(".hljs-deletion");
});

test("RTL: code, tables and the copy button stay LTR inside the Arabic UI", () => {
  expect(CSS).toMatch(/pre\.code\{[^}]*direction:ltr/);
  expect(CSS).toMatch(/\.tbl\{[^}]*direction:ltr/);
  expect(CSS).toMatch(/\.tbl\{[^}]*overflow-x:auto/);
  expect(CSS).toContain("table.md td.num");
});
