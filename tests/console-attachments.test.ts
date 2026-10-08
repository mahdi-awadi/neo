// Composer attachments (ADR-0026): a file is staged as a chip and travels with the next Send. The
// staging model is pure (web/attachments.ts); the DOM wiring and the stylesheet are checked at source.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAttachments, formatSize } from "../src/frontends/web/attachments";
import en from "../src/frontends/web/locales/en/console.json";
import ar from "../src/frontends/web/locales/ar/console.json";

const WEB = join(import.meta.dir, "../src/frontends/web");
const APP = readFileSync(join(WEB, "app.ts"), "utf8");
const HTML = readFileSync(join(WEB, "index.html"), "utf8");
const CSS = HTML.match(/<style>([\s\S]*?)<\/style>/)![1]!;

test("a staged file is uploading, then ready with its token; progress is a whole percent", () => {
  const s = createAttachments();
  const id = s.add("shot.png", 2048);
  expect(s.list()).toEqual([{ id, name: "shot.png", size: 2048, state: "uploading", progress: 0 }]);
  s.progress(id, 512, 2048);
  expect(s.get(id)!.progress).toBe(25);
  s.ready(id, "tok-1");
  expect(s.get(id)).toMatchObject({ state: "ready", progress: 100, token: "tok-1" });
});

test("Send waits for every upload; a failed file must be retried or removed first", () => {
  const s = createAttachments();
  expect(s.canSend("")).toBe(false); // nothing to send
  expect(s.canSend("hi")).toBe(true);
  const a = s.add("a.txt", 1);
  expect(s.canSend("hi")).toBe(false); // uploading
  s.ready(a, "t-a");
  expect(s.canSend("")).toBe(true); // files alone are a message
  const b = s.add("b.txt", 1);
  s.fail(b);
  expect(s.get(b)!.state).toBe("failed");
  expect(s.canSend("hi")).toBe(false);
  s.retry(b);
  expect(s.get(b)).toMatchObject({ state: "uploading", progress: 0 });
  expect(s.remove(b)!.name).toBe("b.txt");
  expect(s.canSend("")).toBe(true);
});

test("the /msg body carries the text, the thread and the ready tokens in order; clear empties it", () => {
  const s = createAttachments();
  const a = s.add("a.png", 1);
  const b = s.add("b.pdf", 1);
  s.ready(b, "t-b");
  s.ready(a, "t-a");
  expect(s.body(" look ", 7)).toEqual({ text: "look", threadId: 7, attachments: ["t-a", "t-b"] });
  expect(s.body("plain")).toEqual({ text: "plain", attachments: ["t-a", "t-b"] });
  s.clear();
  expect(s.list()).toEqual([]);
  expect(s.body("x")).toEqual({ text: "x" });
});

test("removing an unknown or already-removed chip is a no-op", () => {
  const s = createAttachments();
  expect(s.remove(99)).toBeUndefined();
  s.ready(99, "t"); // a late upload for a removed chip changes nothing
  expect(s.list()).toEqual([]);
});

test("formatSize: locale units, one decimal at most", () => {
  expect(formatSize(512, "en")).toBe("512 bytes"); // the long name: "512 byte" reads as a typo
  expect(formatSize(1, "en")).toBe("1 byte");
  expect(formatSize(1536, "en")).toBe("1.5 kB");
  expect(formatSize(5 * 1024 * 1024, "en")).toBe("5 MB");
  // The console's own locale keeps Latin digits in Arabic (app.ts LOCALE), with Arabic unit names.
  const arSize = formatSize(1536, "ar-u-nu-latn");
  expect(arSize).toContain("1.5");
  expect(arSize).not.toBe(formatSize(1536, "en"));
});

test("strings: chip labels in EN and AR", () => {
  for (const cat of [en, ar] as Array<Record<string, any>>) {
    for (const k of ["attRemove", "attRetry", "attUploading", "attFailed", "attList", "attExpired", "attCommand", "attNoProject", "attNotSent"]) expect(cat.feed[k], k).toBeTruthy();
    expect(cat.feed.attRemove).toContain("{{name}}");
    expect(cat.feed.attUploading).toContain("{{pct}}");
  }
  expect(en.feed.attRetry).not.toBe(ar.feed.attRetry);
});

test("both composers stage files (main and thread); nothing uploads straight into a send", () => {
  expect(HTML).toMatch(/<input type="file" id="file" hidden multiple>/);
  expect(HTML).toMatch(/<form class="compose" id="tform"[^>]*>[\s\S]*?id="tattach"[\s\S]*?<\/form>/);
  expect(HTML).toContain('id="ffatts"');
  expect(HTML).toContain('id="tformatts"');
  expect(APP).toContain("new XMLHttpRequest()"); // upload progress
  expect(APP).toContain('"/upload/discard"');
  expect(APP).not.toContain("function sendFile(");
});

test("chips: a scrollable row above the input, 44 px targets on phones, logical properties, LTR names", () => {
  expect(CSS).toMatch(/\.compose\{[^}]*flex-wrap:wrap/);
  expect(CSS).toMatch(/\.atts\{[^}]*flex:1 0 100%/);
  expect(CSS).toMatch(/\.att \.an\{[^}]*unicode-bidi:isolate/);
  expect(CSS).toMatch(/\.att\.err\{/);
  expect(CSS).toMatch(/\.att button[^{]*\{[^}]*min-height:44px/);
});
