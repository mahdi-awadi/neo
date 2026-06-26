import { test, expect } from "bun:test";
import { runConfig } from "../src/engine/session-runner";

test("runConfig forwards disallowedTools when present", () => {
  expect(runConfig({ disallowedTools: ["Write", "Edit", "Bash"] })).toMatchObject({
    disallowedTools: ["Write", "Edit", "Bash"],
  });
});

test("runConfig omits disallowedTools when absent", () => {
  expect(runConfig({})).not.toHaveProperty("disallowedTools");
});
