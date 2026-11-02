import { test, expect, describe } from "bun:test";
import { fileKind, isTextHead, SNIFF_BYTES } from "../src/engine/file-kind";

// Byte fixtures are built here, never checked in: a signature, then a little filler.
const enc = new TextEncoder();
const bytes = (...parts: (string | number[])[]) => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === "string" ? enc.encode(p) : p));
  return new Uint8Array(out);
};
const filler = [0, 0, 0, 1, 2, 3, 0xff, 0xfe];
const DOWNLOAD = { view: "download", mime: "application/octet-stream" };

// A real 1×1 transparent PNG.
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const ftyp = (brand: string) => bytes([0, 0, 0, 0x18], "ftyp", brand, [0, 0, 0, 0], brand, filler);

describe("AC 12: each row of the §3.1 table", () => {
  const rows: [string, Uint8Array, string, string][] = [
    ["a.png", PNG_1X1, "image", "image/png"],
    ["a.PNG", PNG_1X1, "image", "image/png"],
    ["a.jpg", bytes([0xff, 0xd8, 0xff, 0xe0], filler), "image", "image/jpeg"],
    ["a.jpeg", bytes([0xff, 0xd8, 0xff, 0xe0], filler), "image", "image/jpeg"],
    ["a.gif", bytes("GIF89a", filler), "image", "image/gif"],
    ["b.gif", bytes("GIF87a", filler), "image", "image/gif"],
    ["a.webp", bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ", filler), "image", "image/webp"],
    ["a.avif", ftyp("avif"), "image", "image/avif"],
    ["b.avif", ftyp("avis"), "image", "image/avif"],
    ["a.svg", bytes('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'), "svg", "image/svg+xml"],
    ["b.svg", bytes("﻿<!DOCTYPE svg>\n<svg width='1'></svg>"), "svg", "image/svg+xml"],
    ["a.pdf", bytes([1, 2, 3], "%PDF-1.7\n", filler), "pdf", "application/pdf"],
    ["a.mp4", ftyp("isom"), "video", "video/mp4"],
    ["a.m4v", ftyp("M4V "), "video", "video/mp4"],
    ["a.mov", ftyp("qt  "), "video", "video/quicktime"],
    ["a.webm", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], "webm", filler), "video", "video/webm"],
    ["a.mp3", bytes("ID3", [4, 0, 0], filler), "audio", "audio/mpeg"],
    ["b.mp3", bytes([0xff, 0xfb, 0x90, 0x44], filler), "audio", "audio/mpeg"],
    ["a.m4a", ftyp("M4A "), "audio", "audio/mp4"],
    ["a.ogg", bytes("OggS", filler), "audio", "audio/ogg"],
    ["a.opus", bytes("OggS", filler), "audio", "audio/ogg"],
    ["a.wav", bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt ", filler), "audio", "audio/wav"],
    ["a.flac", bytes("fLaC", filler), "audio", "audio/flac"],
  ];
  for (const [name, head, view, mime] of rows) {
    test(`${name} → ${view} ${mime}`, () => {
      expect(fileKind(name, head)).toEqual({ view: view as never, mime });
    });
  }
});

describe("AC 12: text and Markdown", () => {
  const TEXT = "text/plain; charset=utf-8";
  test("report.md → markdown", () => {
    expect(fileKind("report.md", bytes("# Report\n"))).toEqual({ view: "markdown", mime: TEXT });
  });
  test("main.go → text, lang go", () => {
    expect(fileKind("main.go", bytes("package main\n"))).toEqual({ view: "text", mime: TEXT, lang: "go" });
  });
  test("Makefile → text, lang makefile", () => {
    expect(fileKind("Makefile", bytes("all:\n\ttrue\n"))).toEqual({ view: "text", mime: TEXT, lang: "makefile" });
  });
  test("notes (no extension) → text without lang", () => {
    expect(fileKind("notes", bytes("hello\n"))).toEqual({ view: "text", mime: TEXT });
  });
  test("page.html → text (the source, never the page), lang html", () => {
    expect(fileKind("page.html", bytes("<html><script>x()</script></html>"))).toEqual({ view: "text", mime: TEXT, lang: "html" });
  });
  test("x.svg without an <svg root → text, lang svg", () => {
    expect(fileKind("x.svg", bytes("<?xml version='1.0'?><html/>"))).toEqual({ view: "text", mime: TEXT, lang: "svg" });
  });
  test("an unknown extension holding text → text without lang", () => {
    expect(fileKind("run.weird", bytes("ok\n"))).toEqual({ view: "text", mime: TEXT });
  });
  test("an empty .txt → text", () => {
    expect(fileKind("empty.txt", new Uint8Array())).toEqual({ view: "text", mime: TEXT, lang: "txt" });
  });
  test("a path is read by its last segment", () => {
    expect(fileKind("/w/proj/src/main.go", bytes("package main\n")).lang).toBe("go");
  });
});

describe("AC 12: a disagreement → download", () => {
  const cases: [string, Uint8Array][] = [
    ["shot.png", bytes("<html><body>hi</body></html>")],
    ["a.pdf", bytes("just some text, no signature")],
    ["a.pdf", bytes(new Array(1024).fill(0x20), "%PDF-1.7")],
    ["a.txt", bytes("hello", [0], "world")],
    ["a.txt", bytes("hello ", [0xc3, 0x28], " world")],
    ["a.md", bytes([0xff, 0xfe, 0xfd])],
    ["a.mp4", PNG_1X1],
    ["a.mp4", ftyp("qt  ")],
    ["a.mp4", ftyp("M4A ")],
    ["a.mp4", ftyp("avif")],
    ["a.mov", ftyp("isom")],
    ["a.webm", bytes([0x1a, 0x45, 0xdf, 0xa3], "matroska", filler)],
    ["a.mp3", bytes("not audio")],
    ["a.svg", bytes([0], "<svg/>")],
    ["x.svgz", bytes("<svg/>")],
    ["x.zip", bytes("PK", [3, 4], filler)],
    ["x.zip", bytes("plain text in a zip name")],
    ["x.docx", bytes("PK", [3, 4], filler)],
    ["x.exe", bytes("MZ", filler)],
    ["photo.heic", ftyp("heic")],
    ["blob", bytes("ok", [0], "bin")],
  ];
  for (const [name, head] of cases) {
    test(`${name} (${head.length} bytes) → download`, () => {
      expect(fileKind(name, head)).toEqual(DOWNLOAD as never);
    });
  }
});

describe("isTextHead", () => {
  test("plain UTF-8, Arabic included", () => {
    expect(isTextHead(bytes("hello مرحبا\n"))).toBe(true);
  });
  test("a UTF-8 BOM is fine", () => {
    expect(isTextHead(bytes([0xef, 0xbb, 0xbf], "hello"))).toBe(true);
  });
  test("a multi-byte character cut at the end of the head is fine", () => {
    const full = bytes("abc مرحبا 😀");
    for (const cut of [1, 2, 3]) expect(isTextHead(full.subarray(0, full.length - cut))).toBe(true);
  });
  test("a cut character in the middle is not", () => {
    expect(isTextHead(bytes("ab", [0xd9], "cd"))).toBe(false);
  });
  test("a NUL is not text", () => {
    expect(isTextHead(bytes("a", [0], "b"))).toBe(false);
  });
  test("an invalid byte is not text", () => {
    expect(isTextHead(bytes("a", [0xff], "b"))).toBe(false);
  });
  test("a lone continuation byte at the end is not text", () => {
    expect(isTextHead(bytes("ab", [0x80]))).toBe(false);
  });
  test("empty is text", () => {
    expect(isTextHead(new Uint8Array())).toBe(true);
  });
  test("SNIFF_BYTES is 8 KiB", () => {
    expect(SNIFF_BYTES).toBe(8192);
  });
});
