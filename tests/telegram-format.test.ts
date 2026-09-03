import { test, expect } from "bun:test";
import { projectTagPrefix, outboundTag } from "../src/frontends/telegram";
import { mdToHtml } from "../src/engine/format";

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
