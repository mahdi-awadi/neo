// ADR-0056: the build label under the console logo names the RUNNING build — the boot record plus the
// package version read at the same moment — never `dev` or the files on disk later.
import { test, expect } from "bun:test";
import { runningBuild } from "../src/engine/producers/restart";
import { buildLabel } from "../src/frontends/web/build-label";
import { createConsoleI18n } from "../src/frontends/web/i18n";
import { dashboardSnapshot } from "../src/engine/dashboard";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";

const BOOT = { at: 1, headSha: "d85b63898b49cf818d6725a4591fecf6d37b96ff", branch: "master" };

test("runningBuild: the boot commit (short) and branch, plus the package version", () => {
  expect(runningBuild(BOOT, "0.1.0")).toEqual({ version: "0.1.0", sha: "d85b638", branch: "master" });
});

test("runningBuild: no boot record → no build (the label is hidden, never guessed)", () => {
  expect(runningBuild(undefined, "0.1.0")).toBeUndefined();
});

test("runningBuild: a missing or malformed version is left out; the commit still shows", () => {
  expect(runningBuild(BOOT, undefined)).toEqual({ sha: "d85b638", branch: "master" });
  expect(runningBuild(BOOT, "1.0<script>")).toEqual({ sha: "d85b638", branch: "master" });
  expect(runningBuild(BOOT, "2.3.4-rc.1")).toMatchObject({ version: "2.3.4-rc.1" });
});

test("buildLabel: `v<version> · <sha>` in both languages (numbers are not translated)", () => {
  for (const lang of ["en", "ar"] as const) {
    const i18n = createConsoleI18n(lang);
    const tx = (k: string, v?: Record<string, string | number>) => i18n.t(k, { ...v, interpolation: { escapeValue: false } });
    expect(buildLabel(tx, { version: "0.1.0", sha: "d85b638", branch: "master" })).toEqual({
      text: "v0.1.0 · d85b638",
      // The hover text is plain text (no <bdi>): each value is an LTR isolate (LRI … PDI), so a
      // number never reorders inside the Arabic sentence.
      title: tx("brand.versionTitle", { version: "\u20660.1.0\u2069", sha: "\u2066d85b638\u2069", branch: "\u2066master\u2069" }),
    });
    expect(buildLabel(tx, { sha: "d85b638", branch: "master" }).text).toBe("d85b638");
    expect(tx("brand.versionTitle", { version: "0.1.0", sha: "d85b638", branch: "master" })).toContain("d85b638");
  }
});

test("the state snapshot carries the running build beside the deploy gap", () => {
  const s = dashboardSnapshot({
    registry: createRegistry(),
    ledger: openLedger(":memory:"),
    chatId: 0,
    now: 1,
    reposRoot: "/nonexistent",
    build: { version: "0.1.0", sha: "d85b638", branch: "master" },
  });
  expect(s.build).toEqual({ version: "0.1.0", sha: "d85b638", branch: "master" });
  expect("build" in dashboardSnapshot({ registry: createRegistry(), ledger: openLedger(":memory:"), chatId: 0, now: 1, reposRoot: "/nonexistent" })).toBe(false);
});
