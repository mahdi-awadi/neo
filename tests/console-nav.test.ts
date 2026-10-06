// Narrow master–detail and the browser history (spec 2026-10-07, AC4): one pure rule decides, so the
// in-app back and the browser back never fall out of step with what the screen shows.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backAction, enterAction, popDetail, staleOnLoad } from "../src/frontends/web/nav";

const APP = readFileSync(join(import.meta.dir, "../src/frontends/web/app.ts"), "utf8");

/** A tiny browser history + the two detail classes, driven by the same rule app.ts uses. */
function sim(narrow = true) {
  const stack: unknown[] = [null];
  let at = 0;
  const detail = new Set<string>();
  let view: "vthreads" | "vprojects" | null = null;
  const state = () => stack[at];
  const pop = () => {
    detail.clear();
    const v = popDetail(state(), view);
    if (v) detail.add(v);
  };
  return {
    detail,
    stack,
    get at() {
      return at;
    },
    tab(v: "vthreads" | "vprojects" | null) {
      view = v;
    },
    open(v: "vthreads" | "vprojects") {
      view = v;
      detail.add(v);
      const a = enterAction(state(), v, narrow);
      if (a === "push") stack.splice(++at, stack.length, { detail: v });
      else if (a === "replace") stack[at] = { detail: v };
    },
    back() {
      if (backAction(state(), view) === "history") {
        at--;
        pop();
      } else detail.clear();
    },
    reload() {
      detail.clear();
      if (staleOnLoad(state())) stack[at] = null;
    },
  };
}

test("thread detail → Projects tab → project detail → back shows the project list", () => {
  const s = sim();
  s.open("vthreads");
  s.tab("vprojects");
  s.open("vprojects");
  expect(s.stack.length).toBe(2); // replaced, not stacked
  s.back();
  expect([...s.detail]).toEqual([]);
  expect(s.at).toBe(0);
});

test("reload while in detail, then open again: the in-app back works", () => {
  const s = sim();
  s.open("vprojects");
  s.reload();
  expect(s.stack[s.at]).toBeNull();
  s.open("vprojects");
  expect(s.detail.has("vprojects")).toBe(true);
  s.back();
  expect([...s.detail]).toEqual([]);
});

test("popstate re-enters detail only for the view on screen", () => {
  expect(popDetail({ detail: "vthreads" }, "vthreads")).toBe("vthreads");
  expect(popDetail({ detail: "vthreads" }, "vprojects")).toBeNull();
  expect(popDetail(null, "vthreads")).toBeNull();
  expect(popDetail({ detail: "bogus" }, null)).toBeNull();
});

test("enter: push from a list, replace from another detail, nothing when wide or already there", () => {
  expect(enterAction(null, "vthreads", true)).toBe("push");
  expect(enterAction({ detail: "vthreads" }, "vprojects", true)).toBe("replace");
  expect(enterAction({ detail: "vthreads" }, "vthreads", true)).toBe("none");
  expect(enterAction(null, "vthreads", false)).toBe("none");
});

test("back: through history only when the history entry is this view's detail", () => {
  expect(backAction({ detail: "vprojects" }, "vprojects")).toBe("history");
  expect(backAction({ detail: "vthreads" }, "vprojects")).toBe("local");
  expect(backAction(null, "vprojects")).toBe("local");
});

test("app.ts wires the rule: popstate, enterDetail and startup use the helpers", () => {
  expect(APP).toContain("popDetail(history.state");
  expect(APP).toContain("enterAction(history.state");
  expect(APP).toContain("backAction(history.state");
  expect(APP).toMatch(/if \(staleOnLoad\(history\.state\)\) history\.replaceState\(null, ""\)/);
});
