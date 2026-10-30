import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { consolePage, consoleAppJs } from "../src/frontends/web";

// The console is a page shell (src/frontends/web/index.html) plus one browser module (app.ts),
// bundled by Bun.build. These tests read the module's source for the behaviours that matter and
// build the real bundle, so a module that does not compile or parse fails here, not in the browser.
const APP = readFileSync(join(import.meta.dir, "../src/frontends/web/app.ts"), "utf8");
/** One top-level function's source, from its header to the next top-level declaration. */
const fn = (name: string): string => {
  const m = APP.match(new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}\\n`));
  if (!m) throw new Error(`no function ${name} in app.ts`);
  return m[0];
};

test("the console bundle builds and parses as JavaScript", async () => {
  const js = await consoleAppJs();
  expect(js.length).toBeGreaterThan(0);
  // An ESM bundle with no exports is a plain script: new Function compiles it without running it.
  expect(() => new Function(js)).not.toThrow();
});

test("the page shell loads the bundle and embeds the configured feed window", () => {
  const html = consolePage({ feedWindow: 37, appJs: "/app.js?v=abc123" });
  expect(html).toContain('<script type="module" src="/app.js?v=abc123"></script>');
  expect(consolePage()).toContain('<script type="module" src="/app.js"></script>');
  expect(html).toContain('data-feed-window="37"');
  expect(APP).toContain("root.dataset.feedWindow");
});

test("the stream handler renders mirrored echo + notice events and live thread events", () => {
  expect(APP).toContain('e.type === "echo"');
  expect(APP).toContain('e.type === "notice"');
  expect(APP).toContain('e.type === "thread"');
});

test("the project rail renders the derived session state, not the registry lifecycle word", () => {
  const body = fn("renderProjects");
  expect(body).toContain("p.line");
  expect(body).toContain("p.state");
  expect(APP).not.toContain('p.status === "running"');
});

test("the Queue tab renders the todo queues, posts its actions to /api/todo, and can be shown", () => {
  const html = consolePage();
  expect(html).toContain('data-v="todos"');
  expect(html).toContain('id="vtodos"');
  expect(APP).toContain("function renderTodos");
  expect(APP).toContain("/api/todo");
  // ADR-0027: a failed or waiting-retry todo shows and offers Retry.
  expect(APP).toContain('todoAct("retry"');
  expect(APP).toContain('x.status === "failed"');
  // Every view a tab names is one the tab switch toggles (the Queue view used to be missing).
  const views = [...html.matchAll(/class="tab[^"]*" data-v="([a-z]+)"/g)].map((m) => m[1]);
  expect(views.length).toBe(9); // + History (ADR-0067)
  for (const v of views) expect(APP).toMatch(new RegExp(`const VIEWS = \\[[^\\]]*"${v}"`));
});

// ADR-0014: the page keeps a bounded feed and does O(1) work per streamed event.
test("pushFeed never rescans the whole feed or forces a layout per event", () => {
  const push = fn("pushFeed");
  expect(push).not.toContain("refreshFeed()");
  expect(push).not.toContain("scrollHeight");
  expect(push).toContain("scheduleTail()");
  expect(fn("scheduleTail")).toContain("requestAnimationFrame");
});

test("state refresh: one request at a time, bounded by a timeout so a hung fetch cannot stop polling", () => {
  const load = fn("loadState");
  expect(load).toContain("AbortSignal.timeout(POLL_MS)");
  expect(load).toContain("stateLoad = null");
});

test("renderAll skips unchanged sections but always re-renders the clock-dependent Queue tab", () => {
  const all = fn("renderAll");
  expect(all).toContain('changed("loops", S.loops)');
  expect(all).toContain("renderTodos();");
  expect(all).not.toContain('changed("todos"');
  // A direct SDK repaint (switch button, SSE) records what it drew, so a later poll is compared to it.
  expect(fn("renderSdk")).toMatch(/\{\n\s+lastJson\.sdk = /);
});

test("the console shows each project's ctx% with its band and a Context resets timeline", () => {
  const html = consolePage();
  expect(APP).toContain("p.ctxBand");
  expect(APP).toContain("p.lastReset");
  expect(APP).toContain("S.contextEvents");
  expect(APP).toContain('t("recent.ctxTitle")');
  for (const band of ["healthy", "above", "heavy", "emergency"]) expect(html).toContain(`.ctx.${band}`);
});

test("the Threads view: rail, filters, list and pane, paged from the history endpoints", () => {
  const html = consolePage();
  for (const id of ["vthreads", "tprojects", "tq", "tstate", "torigin", "tsince", "trows", "tbody", "tform"]) expect(html).toContain(`id="${id}"`);
  expect(APP).toContain("/api/threads?");
  expect(APP).toContain("/api/thread-projects");
  expect(fn("olderMessages")).toContain("before=");
  // The composer inside a thread posts into it (spec §4.1 rule 2).
  // The thread composer names the open thread in its /msg body (with any staged files, ADR-0026).
  expect(APP).toContain('attach: "tattach", threadId: () => TH.open');
  expect(APP).toContain("void threadComposer.send(typed)");
});

test("a refused send keeps the composer: /msg 409 → a translated note, the text and chips stay (ADR-0026)", () => {
  const html = readFileSync(new URL("../src/frontends/web/index.html", import.meta.url), "utf8");
  for (const id of ["ffnote", "tformnote"]) expect(html).toMatch(new RegExp(`id="${id}" role="alert"`));
  expect(APP).toContain('{ expired: "feed.attExpired", command: "feed.attCommand", "no active project": "feed.attNoProject" }');
  expect(APP).toContain("if (!sent) return; // refused: the text and the chips stay");
});
