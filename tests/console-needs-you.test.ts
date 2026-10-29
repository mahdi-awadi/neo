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
  expect(a).toContain('planAction(it.plan.id, "approve", it.plan.version, btn)');
  expect(a).toContain('todoAct("retry", it.todoId, btn)');
  expect(a).toContain("openTodo(it.todoId, btn)");
  expect(a).toContain("openThread(it.threadId)");
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
    ...["answer", "acknowledge", "retry", "open"].map((k) => `pins.action.${k}`),
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
