// ADR-0067 (task history): the text normalization that `body`, the stems and the query share, its map
// back to the original offsets (so a highlight lands on the text with its harakat), and the Arabic light
// stemmer (Light10 rules, as Lucene's ArabicStemmer). Pure.
import { expect, test } from "bun:test";
import { normalize, normalizeWithMap, toOriginalRange } from "../src/engine/history/normalize";
import { arabicStem, arabicStems } from "../src/engine/history/arabic-stem";

test("harakat, Quranic marks and tatweel are removed", () => {
  expect(normalize("مُحَمَّدٌ")).toBe("محمد");
  expect(normalize("ذٰلِكَ")).toBe("ذلك"); // U+0670 superscript alef
  expect(normalize("الرَّحِيمِ ۝")).toBe("الرحيم "); // U+06DD end of ayah
  expect(normalize("قرآنۖ")).toBe("قران"); // U+06D6 small high ligature
  expect(normalize("كتـــاب")).toBe("كتاب");
});

test("alef forms, alef maqsura, teh marbuta and the Persian yeh and keheh fold", () => {
  expect(normalize("أحمد إسلام آمن ٱلله")).toBe("احمد اسلام امن الله");
  expect(normalize("على")).toBe("علي");
  expect(normalize("مدرسة")).toBe("مدرسه");
  expect(normalize("ایران")).toBe("ايران");
  expect(normalize("کتاب")).toBe("كتاب");
});

test("Arabic-Indic and Persian digits become ASCII; presentation forms fold through NFKC", () => {
  expect(normalize("١٢٣ ٤٥٦٧٨٩٠")).toBe("123 4567890");
  expect(normalize("۱۲۳ ۴۵۶")).toBe("123 456");
  expect(normalize("ﻻ")).toBe("لا"); // lam-alef ligature
  expect(normalize("ﺑﺎﺏ")).toBe("باب"); // presentation forms B
  expect(normalize("ﬁle")).toBe("file");
});

test("zero-width and bidi format characters go; Latin is lowercased", () => {
  expect(normalize("a​b‌c‍d‎e‏f")).toBe("abcdef");
  expect(normalize("‪X‫‬‭‮⁦Y⁧⁨⁩﻿Z")).toBe("xyz");
  expect(normalize("Booking CANCELLED")).toBe("booking cancelled");
});

test("empty input gives empty output, and normalizing twice changes nothing", () => {
  expect(normalize("")).toBe("");
  expect(normalizeWithMap("")).toEqual({ text: "", map: [0] });
  for (const s of [
    "والمقاعدُ لا تُحرَّر بعد الإلغاء ١٢٣",
    "Café É İstanbul ﻻ ﬁ ①",
    "a​‪b ٱلْكِتَابُ کی",
    "👨‍👩‍👧 ok",
    "é Å",
  ]) {
    expect(normalize(normalize(s))).toBe(normalize(s));
  }
});

test("normalize and normalizeWithMap agree, and the map has one entry per normalized char plus the end", () => {
  const s = "والمقاعدُ ﻻ تُحرَّر";
  const r = normalizeWithMap(s);
  expect(r.text).toBe(normalize(s));
  expect(r.map.length).toBe(r.text.length + 1);
  expect(r.map[r.text.length]).toBe(s.length);
  for (let i = 1; i < r.map.length; i++) expect(r.map[i]!).toBeGreaterThanOrEqual(r.map[i - 1]!);
});

test("a match on the normalized text maps back to the original range with the harakat inside the word", () => {
  const original = "قال: والمقاعدُ لا تُحرَّرُ بعد الإلغاء";
  const { text, map } = normalizeWithMap(original);
  const at = text.indexOf("تحرر");
  expect(at).toBeGreaterThan(0);
  const [from, to] = toOriginalRange(map, at, at + "تحرر".length);
  expect(original.slice(from, to)).toBe("تُحرَّرُ");
  const at2 = text.indexOf("المقاعد");
  const [f2, t2] = toOriginalRange(map, at2, at2 + "المقاعد".length);
  expect(original.slice(f2, t2)).toBe("المقاعدُ");
});

test("the map spans a ligature that expands and a tatweel that disappears", () => {
  const original = "x ﻻ كتـــاب y";
  const { text, map } = normalizeWithMap(original);
  const at = text.indexOf("كتاب");
  const [from, to] = toOriginalRange(map, at, at + 4);
  expect(original.slice(from, to)).toBe("كتـــاب");
  const lam = text.indexOf("لا");
  expect(original.slice(...toOriginalRange(map, lam, lam + 2))).toBe("ﻻ");
});

test("light stems: prefixes and suffixes go", () => {
  expect(arabicStem("والمقاعد")).toBe("مقاعد");
  expect(arabicStem("المقاعد")).toBe("مقاعد");
  expect(arabicStem("بالحجز")).toBe("حجز");
  expect(arabicStem("الحجوزات")).toBe("حجوز");
  expect(arabicStem("كالبيت")).toBe("بيت");
  expect(arabicStem("فالعمل")).toBe("عمل");
  expect(arabicStem("للطلاب")).toBe("طلاب");
  expect(arabicStem("وكتاب")).toBe("كتاب");
  expect(arabicStem("معلمون")).toBe("معلم");
  expect(arabicStem("كتابها")).toBe("كتاب");
});

test("light stems keep Lucene's length limits: short words do not change", () => {
  expect(arabicStem("ال")).toBe("ال");
  expect(arabicStem("الم")).toBe("الم"); // "ال" needs 2 letters left
  expect(arabicStem("وقت")).toBe("وقت"); // "و" needs a word of 4 or more
  expect(arabicStem("بان")).toBe("بان"); // "ان" needs 2 letters left
  expect(arabicStem("هو")).toBe("هو");
});

test("arabicStems: the stems of the Arabic tokens only, normalized first, joined by spaces", () => {
  expect(arabicStems("والمقاعدُ booking الحجوزات 123")).toBe("مقاعد حجوز");
  expect(arabicStems("only latin words")).toBe("");
  expect(arabicStems("")).toBe("");
  expect(arabicStems("بِالْحَجْزِ")).toBe("حجز");
});
