import { test, expect } from "bun:test";
import { projectTagPrefix } from "../src/frontends/telegram";
import { mdToHtml } from "../src/engine/format";

test("projectTagPrefix: hashtag + trailing space for a project", () => {
  expect(projectTagPrefix("waselni")).toBe("#waselni ");
  expect(projectTagPrefix("eticket-v3")).toBe("#eticket_v3 ");
});

test("projectTagPrefix: empty for project-less (engine/system) lines", () => {
  expect(projectTagPrefix(undefined)).toBe("");
});

test("outbound HTML line keeps the hashtag plain, outside any code entity", () => {
  const line = projectTagPrefix("waselni") + mdToHtml("⛔️ timed out running `bun test`", { tables: "pre" });
  expect(line.startsWith("#waselni ⛔️ timed out")).toBe(true);
  expect(line).toContain("<code>bun test</code>");
  // the tag itself is never wrapped in markup
  expect(line).not.toMatch(/<[^>]*>#waselni/);
});
