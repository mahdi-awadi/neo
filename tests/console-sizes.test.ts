// ADR-0072 in the console (spec §8, AC 21): every todo row and the threads view's todo line show the size
// chip, with ` ↑` and a title when the order moved up; the todo sheet shows the Size row (chip · who set it)
// and the move's reason from catalogue templates; numbers, paths and commands are LTR isolates.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createConsoleI18n } from "../src/frontends/web/i18n";
import type { Fmt } from "../src/frontends/web/history";
import { numericDate } from "../src/frontends/web/history";
import { sizeChipHtml, sizeRowHtml, sizeUpHtml, SIZE_UP_KINDS } from "../src/frontends/web/todo-size";
import type { SizeUp } from "../src/engine/order-size";

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

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function fmt(lang: "en" | "ar"): Fmt {
  const i = createConsoleI18n(lang);
  return {
    esc, ltr: (s) => `<bdi dir="ltr" class="ref">${esc(s)}</bdi>`, iso: (s) => `<bdi>${esc(s)}</bdi>`,
    t: (k, v) => i.t(k, v ?? {}), tx: (k, v) => i.t(k, { ...v, interpolation: { escapeValue: false } }),
    date: numericDate,
  };
}
const up = (o: Partial<SizeUp>): SizeUp => ({ from: "quick", to: "big", rule: "files", at: 1, ...o });

test("the chip: the catalogue label in the size's class; a move up adds ↑ and a title naming where it came from", () => {
  expect(sizeChipHtml({ size: "quick" }, fmt("en"))).toBe('<span class="tchip sz sz-quick">quick</span>');
  expect(sizeChipHtml({ size: "standard" }, fmt("ar"))).toBe('<span class="tchip sz sz-standard">عادي</span>');
  const moved = sizeChipHtml({ size: "big", sizeUp: up({}) }, fmt("en"));
  expect(moved).toBe('<span class="tchip sz sz-big" title="moved up from quick">big ↑</span>');
  expect(sizeChipHtml({ size: "big", sizeUp: up({}) }, fmt("ar"))).toBe('<span class="tchip sz sz-big" title="رُفع من سريع">كبير ↑</span>');
  // No size (an older payload) or a value that is not a size: no chip, never a raw value in markup.
  expect(sizeChipHtml({}, fmt("en"))).toBe("");
  expect(sizeChipHtml({ size: '"><x>' as never }, fmt("en"))).toBe("");
});

test("the reason line: each move kind from its template, numbers, paths and commands as LTR isolates", () => {
  const en = fmt("en");
  const L = (s: string) => `<bdi dir="ltr" class="ref">${s}</bdi>`;
  expect(sizeUpHtml(up({ to: "standard", rule: "files", value: 6, max: 5 }), en)).toBe(`moved up from quick: ${L("6")} files changed (the limit is ${L("5")})`);
  expect(sizeUpHtml(up({ rule: "lines", value: 1001, max: 1000, from: "standard" }), en)).toBe(`moved up from standard: ${L("1001")} lines changed (the limit is ${L("1000")})`);
  expect(sizeUpHtml(up({ rule: "services", value: 2, max: 1 }), en)).toContain(`${L("2")} services changed`);
  expect(sizeUpHtml(up({ rule: "money", path: "src/wallet/refund.ts" }), en)).toBe(`moved up from quick: it touches payments and money (${L("src/wallet/refund.ts")})`);
  expect(sizeUpHtml(up({ rule: "migration", command: "npx prisma migrate dev" }), en)).toBe(`moved up from quick: it ran a database migration tooling (${L("npx prisma migrate dev")})`);
  expect(sizeUpHtml(up({ rule: "plan" }), en)).toBe("moved up from quick: its plan needs your approval");
  expect(sizeUpHtml(up({ to: "standard", rule: "handoff" }), en)).toBe("moved up from quick: it needed a context handoff");
  expect(sizeUpHtml(up({ rule: "files", value: 7, max: 5, late: true }), en)).toEndWith(" (after it ended)");
  // A project's own rule: its name, as an LTR isolate (escaped).
  expect(sizeUpHtml(up({ rule: "fx<rates>", path: "fx/x.go" }), en)).toBe(`moved up from quick: it touches ${L("fx&lt;rates&gt;")} (${L("fx/x.go")})`);
  // Arabic: translated, the numbers still LTR isolates.
  const ar = sizeUpHtml(up({ to: "standard", rule: "files", value: 6, max: 5 }), fmt("ar"));
  expect(ar).toBe(`رُفع من سريع: تغيّر ${L("6")} ملفات، والحد ${L("5")}`);
  expect(sizeUpHtml(up({ rule: "auth", path: "services/common/authcontext/x.go", late: true }), fmt("ar"))).toBe(`رُفع من سريع: يمسّ الدخول والجلسات والصلاحيات (${L("services/common/authcontext/x.go")}) (بعد انتهائه)`);
  for (const k of SIZE_UP_KINDS) expect(sizeUpHtml(up({ rule: k === "rule" || k === "command" ? "deploy" : k, ...(k === "command" ? { command: "kubectl apply" } : {}) }), en)).not.toContain("todoDetail.");
});

test("the Size row: the chip · who set it, and the reason line when it moved; no setter on an old row", () => {
  const en = fmt("en");
  expect(sizeRowHtml({ size: "quick", sizeBy: "operator" }, en)).toBe('<span class="tchip sz sz-quick">quick</span> · set by you');
  expect(sizeRowHtml({ size: "standard", sizeBy: "company" }, fmt("ar"))).toBe('<span class="tchip sz sz-standard">عادي</span> · حدّده مدير المكتب');
  expect(sizeRowHtml({ size: "big" }, en)).toBe('<span class="tchip sz sz-big">big</span>');
  const moved = sizeRowHtml({ size: "big", sizeBy: "engine", sizeUp: up({ rule: "plan" }) }, en);
  expect(moved).toContain(" · set by Neo");
  expect(moved).toContain('<div class="szup" dir="auto">moved up from quick: its plan needs your approval</div>');
});

test("app.ts: one chip in todoRowHtml (Queue tab and project page), the threads view's todo line, the sheet's Size row", () => {
  expect(APP).toMatch(/import \{[^}]*sizeChipHtml[^}]*\} from "\.\/todo-size"/);
  expect(fn("todoRowHtml")).toContain("sizeChipHtml(x, FMT)");
  expect(APP).toMatch(/v\.todos\.map\(\(x: Any\) => `<div class="tart">\$\{ltr\("#" \+ x\.id\)\}\$\{sizeChipHtml\(x, FMT\)\}/);
  const s = fn("renderTodoSheet");
  expect(s).toContain('["todoDetail.size", sizeRowHtml(d, FMT)]');
  // The history panel and the size helpers share one set of page helpers.
  expect(APP).toContain("fmt: FMT");
});

test("CSS: one class for each size, the pattern of .own-*", () => {
  expect(SHELL).toContain(".sz-quick{color:var(--accent)");
  expect(SHELL).toContain(".sz-standard{color:var(--info)");
  expect(SHELL).toContain(".sz-big{color:var(--warn)");
  expect(SHELL).toMatch(/\.szup\{/);
});
