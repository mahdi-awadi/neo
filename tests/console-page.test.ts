import { test, expect } from "bun:test";
import { consolePage } from "../src/frontends/web";

// The console page embeds a large inline <script>. Neither tsc nor bun test parses that
// served JS, so a syntax error in it ships silently and breaks the ENTIRE console (one
// SyntaxError halts all inline script). A classic trap: a backslash-escaped quote like
// `\'` written inside the TS backtick template literal — the template parser consumes the
// backslash, so the served JS loses the escaping and emits adjacent string literals.
// This guard parses the served script and fails on any such syntax error.
test("consolePage inline <script> parses as valid JavaScript", () => {
  const html = consolePage();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(m).toBeTruthy();
  const body = m![1];
  expect(body.length).toBeGreaterThan(0);
  // new Function compiles (parses) the body without executing it — throws SyntaxError if invalid.
  expect(() => new Function(body)).not.toThrow();
});

test("consolePage's stream handler renders mirrored echo + notice events", () => {
  const html = consolePage();
  const body = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  // The operator's own message mirrored from Telegram → a `me` row (same style as locally-typed).
  expect(body).toContain("e.type==='echo'");
  // Cross-surface chrome (e.g. approval pending on Telegram) → a display-only notice row.
  expect(body).toContain("e.type==='notice'");
});

test("consolePage renders the derived session state, not the registry lifecycle word", () => {
  const html = consolePage();
  // The project row must read the honest one-liner the engine derived, not `status`.
  expect(html).toContain("p.line");
  expect(html).toContain("p.state");
  expect(html).not.toContain("p.status==='running'");
});

test("consolePage has a Queue tab that renders the todo queues and posts its actions to /api/todo", () => {
  const html = consolePage();
  expect(html).toContain(`data-v="todos"`);
  expect(html).toContain(`id="vtodos"`);
  const body = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  expect(body).toContain("function renderTodos");
  expect(body).toContain("/api/todo");
});

// ADR-0014: the page keeps a bounded feed and does O(1) work per streamed event.
test("consolePage embeds the configured feed window", () => {
  const body = consolePage({ feedWindow: 37 }).match(/<script>([\s\S]*?)<\/script>/)![1];
  expect(body).toContain("FEED_WINDOW=37");
  expect(() => new Function(body)).not.toThrow();
});

test("pushFeed never rescans the whole feed or forces a layout per event", () => {
  const body = consolePage().match(/<script>([\s\S]*?)<\/script>/)![1];
  const push = body.match(/function pushFeed\([^)]*\)\{[\s\S]*?\n/)![0];
  expect(push).not.toContain("refreshFeed()");
  expect(push).not.toContain("scrollHeight");
});

test("state refresh: one request at a time, bounded by a timeout so a hung fetch cannot stop polling", () => {
  const body = consolePage().match(/<script>([\s\S]*?)<\/script>/)![1];
  const load = body.match(/function loadState\(\)\{[\s\S]*?stateLoad=null[\s\S]*?return stateLoad;\}/)![0];
  expect(load).toContain("AbortSignal.timeout(POLL_MS)");
  expect(load).toContain("stateLoad=null");
});

test("renderAll skips unchanged sections but always re-renders the clock-dependent Queue tab", () => {
  const body = consolePage().match(/<script>([\s\S]*?)<\/script>/)![1];
  const all = body.match(/function renderAll\(\)\{[\s\S]*?\}\n/)![0];
  expect(all).toContain("changed('loops',S.loops)");
  expect(all).toContain("renderTodos();");
  expect(all).not.toContain("changed('todos'");
  // A direct SDK repaint (switch button, SSE) records what it drew, so a later poll is compared to it.
  expect(body).toMatch(/function renderSdk\(\)\{lastJson\.sdk=/);
});

test("consolePage shows each project's ctx% with its band and a Context resets timeline", () => {
  const html = consolePage();
  expect(html).toContain("p.ctxBand");
  expect(html).toContain("p.lastReset");
  expect(html).toContain("S.contextEvents");
  expect(html).toContain("Context resets");
  for (const band of ["healthy", "above", "heavy", "emergency"]) expect(html).toContain(`.ctx.${band}`);
});

// Paste-to-attach: an image pasted into the composer goes through the SAME /upload path as 📎.
const consoleScript = () => consolePage().match(/<script>([\s\S]*?)<\/script>/)![1];
const pastedImages = (): ((items: unknown, now: number) => File[]) => {
  const src = consoleScript().match(/function pastedImages\([^)]*\)\{[\s\S]*?\n/)![0];
  return new Function(`${src}; return pastedImages;`)();
};
const fileItem = (type: string, name = "image.png") => ({ kind: "file", type, getAsFile: () => new File([new Uint8Array([1, 2, 3])], name, { type }) });
const textItem = (type = "text/plain") => ({ kind: "string", type, getAsFile: () => null });

test("pastedImages: each image/* file item becomes a File named pasted-<timestamp>.<ext>", () => {
  const files = pastedImages()([fileItem("image/png"), fileItem("image/jpeg", "x.jpg")], 1700000000000);
  expect(files.map((f) => f.name)).toEqual(["pasted-1700000000000.png", "pasted-1700000000000-2.jpeg"]);
  expect(files.map((f) => f.type)).toEqual(["image/png", "image/jpeg"]);
  expect(files[0]!.size).toBe(3);
});

test("pastedImages: text-only paste yields nothing; text+image yields only the image; non-image files are skipped", () => {
  const pick = pastedImages();
  expect(pick([textItem(), textItem("text/html")], 1)).toEqual([]);
  expect(pick([textItem(), fileItem("image/png")], 1).map((f) => f.name)).toEqual(["pasted-1.png"]);
  expect(pick([fileItem("application/pdf", "a.pdf")], 1)).toEqual([]);
  expect(pick(undefined, 1)).toEqual([]);
});

test("the composer attaches pasted images through the shared /upload sender and never blocks the text paste", () => {
  const body = consoleScript();
  expect(body).toContain("addEventListener('paste'");
  const paste = body.match(/addEventListener\('paste'[\s\S]*?\n/)![0];
  expect(paste).toContain("pastedImages(");
  expect(paste).toContain("sendFile");
  expect(paste).not.toContain("preventDefault");
  // One upload mechanism: the 📎 picker and paste both go through sendFile → /upload.
  expect(body.match(/fetch\('\/upload'/g)).toHaveLength(1);
  expect(body).toMatch(/function uploadFile\(\)\{[^\n]*sendFile\(/);
});
