// ADR-0065 in the console: the "Pinned — needs you" strip on every tab, the project page split (needs you
// first, housekeeping collapsed), tappable todo rows that open a detail sheet, and AR+EN keys for all of it
// with numbers as left-to-right runs.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";

const WEB = join(import.meta.dir, "../src/frontends/web");
const APP = readFileSync(join(WEB, "app.ts"), "utf8");
const SHELL = readFileSync(join(WEB, "index.html"), "utf8");

/** One top-level function's source. */
function fn(name: string): string {
  const start = APP.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = APP.indexOf("\nfunction ", start + 1);
  return APP.slice(start, next === -1 ? undefined : next);
}

const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

test("the strip sits under the tab bar, outside every view, so it shows on every tab; the detail is a modal dialog", () => {
  const strip = SHELL.indexOf('id="pins"');
  expect(strip).toBeGreaterThan(SHELL.indexOf('id="tabs"'));
  expect(strip).toBeLessThan(SHELL.indexOf('id="vactivity"'));
  expect(SHELL).toMatch(/<dialog class="sheet" id="tdsheet" aria-labelledby="tdtitle">/);
  // One render path: loadPins (each poll), never also renderAll — a double rebuild dropped busy state.
  expect(fn("renderAll")).not.toContain("renderPins()");
  expect(fn("loadPins")).toContain('box.querySelector(".busy")');
  expect(fn("loadPins")).toContain("box.contains(document.activeElement)");
  expect(fn("loadState")).toContain("loadPins()");
  expect(fn("loadPins")).toContain("/api/needs-you");
});

test("a strip row: kind, project, one-line why, its action, and a control that takes it off the list", () => {
  expect(fn("renderPins")).toContain("PIN_SHOWN");
  expect(fn("renderPins")).toContain("pinRow(it, loadPins)");
  const r = fn("pinRow");
  expect(r).toContain("pins.kind.${it.kind}");
  expect(r).toContain('dir="auto"');
  expect(r).toContain('"/api/pin", { ref: it.ref, state: "unpinned" }, tx("pins.hidden")');
  expect(r).toContain('setAttribute("aria-label", tx("pins.hide"))');
  const a = fn("pinAction");
  // ADR-0071: Retry stays one tap; every other button opens the item itself — never the project page,
  // never a blind plan approve.
  expect(a).toContain('todoAct("retry", it.todoId, btn)');
  expect(a).toContain("openTodo(it.todoId, btn)");
  expect(a).toContain("openItem(it.ref, btn)");
  expect(a).not.toContain("showProject(");
  expect(a).not.toContain('planAction(it.plan.id, "approve"');
  expect(fn("pinRow")).toContain("tx(`pins.action.${it.action}`)");
});

// ADR-0071: Open lands on the item, with its full text and its actions; a plan is read before approval.
test("openItem reads /api/item and fills the one sheet; a todo keeps its own sheet", () => {
  const o = fn("openItem");
  expect(o).toContain("/api/item?ref=");
  expect(o).toContain('setAttribute("aria-busy", "true")');
  expect(o).toContain("renderItemSheet(");
  expect(o).toContain("sheet().showModal()");
  expect(o).toContain('tx("item.notFound")');
  expect(fn("pinAction")).toContain('it.kind === "todo"');
});

test("a decision: the full question, its card, one button per option and a reply box that answers it", () => {
  const d = fn("decisionBlock");
  expect(d).toContain("decisionCardHtml(");
  expect(d).toContain('dir="auto"');
  expect(d).toContain("answerDecision(");
  expect(d).toContain('data-compose="send"');
  expect(d).toContain("<textarea");
  expect(d).toContain('tx("item.reply.placeholder")');
  expect(d).toContain('tx("pins.action.acknowledge")');
  // A card with several questions, or a multi-select one, collects picks and sends them with one Submit
  // (the server joins them exactly as a Telegram Submit does); a one-question card answers with a tap.
  expect(d).toContain('type="${q.multiSelect ? "checkbox" : "radio"}"');
  expect(d).toContain("{ picks }");
  expect(d).toContain('tx("item.submit")');
  const a = fn("answerDecision");
  expect(a).toContain('"/api/decision/answer"');
  expect(a).toContain("loadPins()");
});

test("a plan: rendered from /md-file?view=html, a Download link, Approve & build and Drop (confirmed)", () => {
  const p = fn("planBlock");
  expect(p).toContain("mdFileHref(");
  expect(p).toContain('"&view=html"');
  expect(p).toContain("download");
  expect(p).toContain('planAction(pl.id, "approve", pl.version');
  expect(p).toContain('planAction(pl.id, "drop", pl.version');
  expect(p).toContain('confirm(tx("item.plan.confirmDrop"))');
  expect(p).toContain('tx("item.plan.missing"');
  expect(p).toContain("enhanceCode(");
});

test("an attention item: the project page's own renderer and buttons, plus the decision it is about", () => {
  const r = fn("renderItemSheet");
  expect(r).toContain("attentionItemHtml(");
  expect(r).toContain("attentionButtons(");
  expect(r).toContain("d.linked");
  expect(r).toContain("decisionBlock(");
  expect(r).toContain("planBlock(");
});

test("mobile typing: the sheet stays above the keyboard and a focused field scrolls into view", () => {
  expect(SHELL).toMatch(/\.sheet\{[^}]*max-height:min\(86vh,900px,var\(--app-h,100dvh\)\)/);
  expect(SHELL).toMatch(/max-height:min\(88vh,var\(--app-h,100dvh\)\)/);
  expect(APP).toContain('sheet().addEventListener("focusin"');
  expect(APP).toContain('scrollIntoView({ block: "nearest"');
});

test("todo rows in the Queue tab and on the project page are one button each that opens the detail", () => {
  expect(fn("renderTodos")).toContain("todoRowHtml(x,");
  expect(fn("renderProjectPane")).toContain("todoRowHtml(x,");
  expect(fn("todoRowHtml")).toContain('data-act="todo-open"');
  expect(fn("todoRowHtml")).toMatch(/<button class="qrow" type="button"/);
  expect(APP).toContain('case "todo-open":\n      return openTodo(Number(id), el);');
  const o = fn("openTodo");
  expect(o).toContain('setAttribute("aria-busy", "true")');
  expect(o).toContain("/api/todo/");
  expect(o).toContain("showModal()");
  expect(o).toContain('tx("todoDetail.notFound")');
  const d = fn("renderTodoSheet");
  for (const k of ["todoDetail.project", "todoDetail.lane", "todoDetail.state", "todoDetail.created", "todoDetail.result", "todoDetail.brief", "todoDetail.openThread"]) expect(d).toContain(k);
  expect(d).toContain("todoAct(a, d.id, b)");
});

test("the project page: needs you first, housekeeping collapsed under its count; housekeeping items can be pinned", () => {
  const p = fn("renderProjectPane");
  expect(p).toContain("needRefs.has(`att:${it.id}`)");
  expect(p).toContain('<details class="hk">');
  expect(p).toContain("pj.sect.housekeeping");
  expect(p).toContain('ref: `att:${it.id}`');
  expect(fn("attentionCounts")).toContain("s.needs");
  // The section counts the project's whole needs-you list (the badge), plans and decisions included.
  expect(p).toContain('filter((it) => it.kind !== "attention")');
  expect(p).toContain("pinRow(it, reload)");
});

test("every dynamic key exists in EN and AR, and AR is translated", () => {
  const keys = [
    ...["plan", "decision", "alert", "todo", "attention"].map((k) => `pins.kind.${k}`),
    ...["review", "answer", "acknowledge", "retry", "open"].map((k) => `pins.action.${k}`),
    "item.notFound", "item.submit", "item.reply.label", "item.reply.placeholder", "item.reply.send", "item.answered", "item.closed", "item.question",
    "item.plan.download", "item.plan.loading", "item.plan.missing", "item.plan.confirmDrop", "item.about", "threads.planAction.drop",
    ...["queued", "running", "retry", "waiting", "failed", "done", "cancelled"].map((k) => `todoDetail.status.${k}`),
    "pins.pinned", "pins.unpinned", "pins.hidden",
    "pins.title", "pins.more", "pins.less", "pins.hide", "pins.pin", "pins.unpin", "pins.toggle", "pins.noProject",
    "toast.done", "toast.failed", "pj.needs", "pj.housekeeping", "pj.sect.needsYou", "pj.sect.housekeeping",
    "todoDetail.open", "todoDetail.close", "todoDetail.notFound", "todoDetail.position", "todoDetail.laneSide", "todoDetail.ago",
    "threads.planAction.approve",
  ];
  for (const k of keys) {
    expect(typeof get(en, k)).toBe("string");
    expect(typeof get(ar, k)).toBe("string");
    if (!["pins.noProject"].includes(k)) expect(get(ar, k)).not.toBe(get(en, k));
  }
});

test("numbers stay left-to-right runs in Arabic: counts, ids, positions and times go through ltr()", () => {
  expect(APP).toContain('tx("pins.more", { n: ltr(items.length) })');
  expect(APP).toContain('tx("pj.needs", { n: ltr(s.needs) })');
  expect(APP).toContain(`tx("pj.sect.needsYou", { n: ltr(others.length + needs.length) })`);
  expect(APP).toContain('tx("todoDetail.position", { pos: ltr(d.position) })');
  expect(fn("renderTodoSheet")).toContain("ltr(clock(at))");
  expect(fn("todoRowHtml")).toContain('ltr("#" + x.id)');
});
