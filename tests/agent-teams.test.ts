import { test, expect } from "bun:test";
import { frontendBackend, teamLeadPreamble } from "../src/engine/agent-teams";

test("frontendBackend defines exactly backend + frontend, each with sensible tools + inherit model", () => {
  expect(Object.keys(frontendBackend).sort()).toEqual(["backend", "frontend"]);
  for (const agent of Object.values(frontendBackend)) {
    expect(agent.description.length).toBeGreaterThan(0);
    expect(agent.prompt.length).toBeGreaterThan(0);
    expect(agent.model).toBe("inherit"); // inherit the dispatch worker's model, no per-team override
    for (const t of ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]) {
      expect(agent.tools).toContain(t);
    }
  }
});

test("the backend agent is scoped to server/API work, the frontend agent to UI/client work", () => {
  expect(frontendBackend.backend.description.toLowerCase()).toContain("backend");
  expect(frontendBackend.frontend.description.toLowerCase()).toContain("frontend");
});

test("teamLeadPreamble names both agents, states the file-ownership rule + shared-contract coordination, then the task verbatim", () => {
  const out = teamLeadPreamble("BUILD THE DASHBOARD");
  expect(out).toContain("backend"); // delegate to the backend agent
  expect(out).toContain("frontend"); // delegate to the frontend agent
  expect(out.toLowerCase()).toContain("file ownership"); // non-overlapping path boundaries
  expect(out.toLowerCase()).toContain("contract"); // coordinate via a shared contract file (no direct messaging)
  expect(out.endsWith("BUILD THE DASHBOARD")).toBe(true); // the original brief is appended verbatim, last
});
