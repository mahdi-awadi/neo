import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enterKey, fitHeight } from "../src/frontends/web/compose-box";
import { linesHtml } from "../src/frontends/web/text-lines";
import { mdToHtml } from "../src/engine/format";

// ADR-0033: one compose box for every console field that takes a message or a brief, and text that
// keeps its own direction per line.
const WEB = join(import.meta.dir, "../src/frontends/web");
const APP = readFileSync(join(WEB, "app.ts"), "utf8");
const HTML = readFileSync(join(WEB, "index.html"), "utf8");

const key = (k: Partial<Parameters<typeof enterKey>[0]> = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...k });

test("enterKey: Enter sends on a desktop; Shift+Enter or Alt+Enter is a new line", () => {
  expect(enterKey(key(), { touch: false, sends: true })).toBe("send");
  expect(enterKey(key({ shiftKey: true }), { touch: false, sends: true })).toBe("newline");
  expect(enterKey(key({ altKey: true }), { touch: false, sends: true })).toBe("newline");
});

test("enterKey: on a touch screen Enter is a new line; Ctrl/Cmd+Enter still sends", () => {
  expect(enterKey(key(), { touch: true, sends: true })).toBe("newline");
  expect(enterKey(key({ ctrlKey: true }), { touch: true, sends: true })).toBe("send");
  expect(enterKey(key({ metaKey: true }), { touch: false, sends: true })).toBe("send");
});

test("enterKey: an IME composition (Arabic, CJK) keeps its Enter; other keys are ignored", () => {
  expect(enterKey(key({ isComposing: true }), { touch: false, sends: true })).toBe("ignore");
  expect(enterKey(key({ key: "a" }), { touch: false, sends: true })).toBe("ignore");
});

test("enterKey: a box that does not send (a customer reply draft) never sends on Enter", () => {
  expect(enterKey(key(), { touch: false, sends: false })).toBe("newline");
  expect(enterKey(key({ ctrlKey: true }), { touch: false, sends: false })).toBe("newline");
});

test("fitHeight: the box grows with its text up to its max height, then scrolls", () => {
  expect(fitHeight(60, 240)).toEqual({ height: 60, scroll: false });
  expect(fitHeight(400, 240)).toEqual({ height: 240, scroll: true });
  expect(fitHeight(400, Number.NaN)).toEqual({ height: 400, scroll: false }); // no max-height in CSS
});

test("linesHtml: every line is its own dir=auto block; line breaks and empty lines are kept", () => {
  expect(linesHtml("first\n\nسطر ثانٍ")).toBe('<div dir="auto">first</div><div dir="auto"><br></div><div dir="auto">سطر ثانٍ</div>');
  expect(linesHtml("a\r\nb")).toBe('<div dir="auto">a</div><div dir="auto">b</div>');
});

test("linesHtml: text is escaped; numbers in an Arabic message stay an LTR run", () => {
  expect(linesHtml("<b>x</b> & y")).toBe('<div dir="auto">&lt;b&gt;x&lt;/b&gt; &amp; y</div>');
  expect(linesHtml("المبلغ 1,250,000 دينار")).toContain('<bdi dir="ltr" class="n">1,250,000</bdi>');
  expect(linesHtml("version 2 of E2E")).toBe('<div dir="auto">version 2 of E2E</div>'); // no RTL: untouched
});

test("web markdown: blocks and list items take their own direction; each line of a paragraph too", () => {
  const html = mdToHtml("الاستمارات:\n* سطر أول.\n* second line.\n\nfirst\nثاني", { target: "web" });
  expect(html).toContain('<ul><li dir="auto">');
  expect(html).toContain('<div class="lines"><div dir="auto">first</div><div dir="auto">ثاني</div></div>');
  expect(mdToHtml("one line", { target: "web" })).toBe("one line"); // a one-line message stays bare
  expect(mdToHtml("one\ntwo", { target: "web" })).toBe('<div class="lines"><div dir="auto">one</div><div dir="auto">two</div></div>');
  // A tag that spans a line break is never cut in half: the paragraph keeps its <br>.
  expect(mdToHtml("**bold\nstill bold**", { target: "web" })).toBe("<strong>bold<br>still bold</strong>");
  expect(mdToHtml("x\n\n**bold\nstill bold**", { target: "web" })).toBe('<p dir="auto">x</p><p dir="auto"><strong>bold<br>still bold</strong></p>');
});

test("Telegram's compact target is unchanged (plain newlines, no dir attributes)", () => {
  expect(mdToHtml("a\nb\n\n- x")).toBe("a\nb\n\n• x");
});

test("the main, thread and new-project boxes are multi-line compose boxes that send on Enter", () => {
  for (const id of ["msg", "tmsg", "task"]) {
    const tag = HTML.match(new RegExp(`<textarea id="${id}"[^>]*>`))?.[0] ?? "";
    expect(tag).toContain('data-compose="send"');
    expect(tag).toContain('dir="auto"');
    expect(tag).toContain('rows="1"');
  }
  expect(HTML).not.toMatch(/<input id="(msg|tmsg)"/);
});

test("inbox instructions and notes are compose boxes that send; the customer draft and loop prompt only grow", () => {
  expect(APP).toMatch(/<textarea class="iinp" id="instr-\$\{id\}" rows="1" dir="auto" data-compose="send"/);
  expect(APP).toMatch(/<textarea class="iinp" id="notes-\$\{id\}" rows="1" dir="auto" data-compose="send"/);
  expect(APP).toMatch(/<textarea class="itx" id="draft-\$\{id\}" dir="auto" data-compose="text"/);
  expect(APP).toMatch(/<textarea id="lc-prompt" class="itx" dir="auto" data-compose="text"/);
  expect(APP).not.toMatch(/<input class="iinp"/);
});

test("ONE compose-box binding for the whole page (delegated), and every send clears through it", () => {
  expect(APP.match(/bindComposeBoxes\(/g)).toHaveLength(1);
  // The forms and the new-project box clear with clearBox, so the height shrinks back too.
  expect(APP.match(/clearBox\(/g)!.length).toBeGreaterThanOrEqual(3);
  expect(APP).not.toMatch(/as HTMLInputElement\)\.value = ""/);
});

test("the operator's own lines (sent here, mirrored from Telegram, in a thread) render line by line", () => {
  expect(APP).toMatch(/function ownLine[\s\S]*?linesHtml\(text\)/);
  expect(APP).toMatch(/e\.type === "echo"\) \{\s*feedMsg\(ownRow\(ownLine\(e\.text, \[\]\)\)/);
  expect(APP).toMatch(/feedMsg\(ownRow\(ownLine\(sent\.body\.text, sent\.names\)\)/);
  expect(APP).toMatch(/html \?\? m\.html \?\? linesHtml\(m\.content\)/);
});

test("the compose hint exists in both catalogues", () => {
  for (const lang of ["en", "ar"]) {
    const cat = JSON.parse(readFileSync(join(WEB, `locales/${lang}/console.json`), "utf8"));
    expect(typeof cat.feed.composeHint).toBe("string");
  }
});
