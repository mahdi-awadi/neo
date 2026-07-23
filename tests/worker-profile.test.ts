import { test, expect } from "bun:test";
import { profileDeps } from "../src/engine/worker-profile";

const cfg = {
  workers: {
    company: { effort: "low" as const }, project: {}, dispatch: {},
    loop: { model: "sonnet", skills: [] as string[] },
    judge: { model: "haiku", effort: "low" as const },
    ingress: { effort: "low" as const }, handoff: { model: "haiku", effort: "low" as const },
  },
  workerEnv: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" },
};

test("profileDeps folds the path profile + workerEnv into RunDeps", () => {
  const d = profileDeps(cfg, "loop");
  expect(d.model).toBe("sonnet");
  expect(d.skills).toEqual([]);
  expect(d.env).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" });
});

test("call-site base wins over the profile and keeps unrelated fields", () => {
  const d = profileDeps(cfg, "judge", { effort: "medium", disallowedTools: ["Write"] });
  expect(d.effort).toBe("medium");        // base beats profile
  expect(d.model).toBe("haiku");          // profile fills the gap
  expect(d.disallowedTools).toEqual(["Write"]);
});

test("empty profile + empty env adds nothing (inherit = today's behavior)", () => {
  expect(profileDeps({ workers: cfg.workers, workerEnv: {} }, "dispatch")).toEqual({});
});
