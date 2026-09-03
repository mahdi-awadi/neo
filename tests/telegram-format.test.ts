import { test, expect } from "bun:test";
import { projectTagPrefix, outboundTag, structuredKeyboard } from "../src/frontends/telegram";
import { mdToHtml } from "../src/engine/format";
import { singleQuestionAsk, emptySelection, applyTap, encodeOptionTap, encodeSubmit, encodeOther } from "../src/engine/structured-question";

test("structuredKeyboard maps the pure spec to grammy buttons with the right callback data + ✓", () => {
  const ask = singleQuestionAsk("features?", ["Auth", "Billing"], true); // multi-select → Submit shown
  const sel = applyTap(ask, emptySelection(ask), 0, 0); // Auth selected
  const flat = structuredKeyboard("d1", ask, sel).inline_keyboard.flat();
  const datas = flat.map((b) => "callback_data" in b ? b.callback_data : undefined);
  expect(datas).toContain(encodeOptionTap("d1", 0, 0));
  expect(datas).toContain(encodeSubmit("d1")); // Submit for multi-select
  expect(datas).toContain(encodeOther("d1")); // implicit free-form Other
  const auth = flat.find((b) => "callback_data" in b && b.callback_data === encodeOptionTap("d1", 0, 0))!;
  expect(auth.text).toContain("✓"); // the selected option is checkmarked

  // A single single-select question shows NO Submit (it resolves on one tap — today's UX).
  const single = structuredKeyboard("d2", singleQuestionAsk("Postgres or Mongo?", ["Postgres", "Mongo"]))
    .inline_keyboard.flat()
    .map((b) => ("callback_data" in b ? b.callback_data : undefined));
  expect(single).not.toContain(encodeSubmit("d2"));
});

test("projectTagPrefix: hashtag + trailing space for a project", () => {
  expect(projectTagPrefix("waselni")).toBe("#waselni ");
  expect(projectTagPrefix("eticket-v3")).toBe("#eticket_v3 ");
});

test("projectTagPrefix: empty for project-less (engine/system) lines", () => {
  expect(projectTagPrefix(undefined)).toBe("");
});

test("outboundTag composes the priority accent in front of the #project tag", () => {
  // Feature 2: a done/alert line leads with its single colored accent, then the project tag.
  expect(outboundTag("eticket-v3", "done")).toBe("🟢 #eticket_v3 ");
  expect(outboundTag("waselni", "alert")).toBe("🔴 #waselni ");
  // progress (default) stays silent — just the tag, exactly as today.
  expect(outboundTag("waselni", "progress")).toBe("#waselni ");
  expect(outboundTag("waselni")).toBe("#waselni ");
  // engine/system line with no project: accent only for attention priorities.
  expect(outboundTag(undefined, "alert")).toBe("🔴 ");
  expect(outboundTag(undefined, "progress")).toBe("");
});

test("outbound HTML line keeps the hashtag plain, outside any code entity", () => {
  const line = projectTagPrefix("waselni") + mdToHtml("⛔️ timed out running `bun test`", { tables: "pre" });
  expect(line.startsWith("#waselni ⛔️ timed out")).toBe(true);
  expect(line).toContain("<code>bun test</code>");
  // the tag itself is never wrapped in markup
  expect(line).not.toMatch(/<[^>]*>#waselni/);
});
