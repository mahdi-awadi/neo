import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pastedImages } from "../src/frontends/web/paste";

// Paste-to-attach: an image pasted into the composer goes through the SAME /upload path as 📎.
const APP = readFileSync(join(import.meta.dir, "../src/frontends/web/app.ts"), "utf8");
const fileItem = (type: string, name = "image.png") => ({ kind: "file", type, getAsFile: () => new File([new Uint8Array([1, 2, 3])], name, { type }) });
const textItem = (type = "text/plain") => ({ kind: "string", type, getAsFile: () => null });

test("pastedImages: each image/* file item becomes a File named pasted-<timestamp>.<ext>", () => {
  const files = pastedImages([fileItem("image/png"), fileItem("image/jpeg", "x.jpg")], 1700000000000);
  expect(files.map((f) => f.name)).toEqual(["pasted-1700000000000.png", "pasted-1700000000000-2.jpeg"]);
  expect(files.map((f) => f.type)).toEqual(["image/png", "image/jpeg"]);
  expect(files[0]!.size).toBe(3);
});

test("pastedImages: text-only paste yields nothing; text+image yields only the image; non-image files are skipped", () => {
  expect(pastedImages([textItem(), textItem("text/html")], 1)).toEqual([]);
  expect(pastedImages([textItem(), fileItem("image/png")], 1).map((f) => f.name)).toEqual(["pasted-1.png"]);
  expect(pastedImages([fileItem("application/pdf", "a.pdf")], 1)).toEqual([]);
  expect(pastedImages(undefined, 1)).toEqual([]);
});

test("the composer stages pasted images through the shared upload path and never blocks the text paste", () => {
  const paste = APP.match(/addEventListener\("paste"[\s\S]*?\}\);/)![0];
  expect(paste).toContain("add(pastedImages(");
  expect(paste).not.toContain("preventDefault");
  // One upload mechanism (ADR-0026): the 📎 picker and paste both stage through add() → /upload.
  expect(APP.match(/open\("POST", "\/upload"\)/g)).toHaveLength(1);
  expect(APP).not.toMatch(/fetch\("\/upload"/);
  expect(APP).toMatch(/picker\.onchange = \(\) => \{[\s\S]*?add\(picker\.files\)/);
});
