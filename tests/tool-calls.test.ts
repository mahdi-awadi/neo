// ADR-0058: the runner knows each running tool call (and its SDK task) of a session.
import { test, expect } from "bun:test";
import { createToolCalls, markCommand, MARKER_ENV, logPathOf } from "../src/engine/tool-calls";

test("a tool call runs from its tool_use to its tool_result; its summary is the command or description", () => {
  let t = 1000;
  const c = createToolCalls(() => t);
  c.onToolUse("tu1", "Bash", { command: "git push origin dev\nsecond line" });
  t = 2000;
  c.onToolUse("tu2", "Task", { description: "review the diff", prompt: "…" });
  expect(c.running()).toEqual([
    { toolUseId: "tu1", tool: "Bash", summary: "git push origin dev", since: 1000 },
    { toolUseId: "tu2", tool: "Task", summary: "review the diff", since: 2000 },
  ]);
  c.onToolResult("tu1", "done");
  expect(c.running().map((r) => r.toolUseId)).toEqual(["tu2"]);
  c.onToolUse(undefined, "Bash", { command: "x" }); // no id: never trackable
  expect(c.running()).toHaveLength(1);
});

test("task_started names the call's SDK task (foreground too); a backgrounded call leaves the running list with its log", () => {
  const c = createToolCalls(() => 0);
  c.onToolUse("tu1", "Bash", { command: "sleep 300" });
  c.onTask({ subtype: "task_started", task_id: "bx1", tool_use_id: "tu1" });
  expect(c.running()[0]!.taskId).toBe("bx1");
  expect(c.taskOf("tu1")).toBe("bx1");
  c.onToolResult("tu1", "Command was manually backgrounded by user with ID: bx1. Output is being written to: /tmp/claude-0/x/tasks/bx1.output. If it is still running…");
  expect(c.running()).toEqual([]);
  expect(c.logOf("tu1")).toBe("/tmp/claude-0/x/tasks/bx1.output");
  expect(c.taskOf("tu1")).toBe("bx1"); // still known: a backgrounded task can be stopped
  c.onTask({ subtype: "task_notification", task_id: "bx1", tool_use_id: "tu1", status: "stopped", output_file: "/tmp/o" });
  expect(c.taskOf("tu1")).toBeUndefined(); // ended: nothing left to stop
});

test("logPathOf reads the SDK's backgrounded-call text", () => {
  expect(logPathOf("…Output is being written to: /tmp/a b/c.output. If it…")).toBe("/tmp/a b/c.output");
  expect(logPathOf("plain output")).toBeUndefined();
});

test("the marker: one exported env per call, added once", () => {
  expect(MARKER_ENV).toBe("NEO_TOOL_USE_ID");
  expect(markCommand("toolu_1", "git push")).toBe("export NEO_TOOL_USE_ID=toolu_1; git push");
  expect(markCommand("toolu_1", markCommand("toolu_1", "git push"))).toBe("export NEO_TOOL_USE_ID=toolu_1; git push");
  expect(markCommand("bad id;rm -rf /", "x")).toBe("x"); // an id that is not a plain token is never put in a shell
});
