import { test, expect } from "bun:test";
import { runOrder } from "../src/engine/session-runner";
import type { Order } from "../src/types";

function order(task = "do it", folder = "/tmp"): Order {
  return { id: "o1", source: "neo", folder, task, chatId: 1, createdAt: 1 };
}

// A fake SDK `query` that drives options.canUseTool with the given tool requests,
// records each decision it got back, and yields a realistic message stream.
function fakeQuery(reqs: Array<{ tool: string; input: Record<string, unknown> }>) {
  const decisions: Array<{ behavior: string; updatedInput?: unknown; message?: string }> = [];
  const q = (args: { prompt: string; options: any }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      yield { type: "assistant", message: { content: [{ type: "text", text: "working" }] } };
      for (const r of reqs) {
        decisions.push(await args.options.canUseTool(r.tool, r.input));
      }
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 0.01,
        session_id: "sess-1",
      };
    })();
  return { q, decisions };
}

test("runOrder auto-allows a safe tool (echoing updatedInput), forwards text, returns result", async () => {
  const { q, decisions } = fakeQuery([{ tool: "Write", input: { file_path: "/x", content: "y" } }]);
  const messages: string[] = [];
  const result = await runOrder(
    order(),
    { onMessage: (t) => messages.push(t), onEscalation: async () => "deny" },
    { query: q },
  );

  expect(decisions[0]).toEqual({ behavior: "allow", updatedInput: { file_path: "/x", content: "y" } });
  expect(messages).toContain("working");
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("done");
  expect(result.sessionId).toBe("sess-1");
  expect(result.costUsd).toBe(0.01);
});

test("runOrder escalates a risky tool and denies it when the human denies", async () => {
  let reason = "";
  const { q, decisions } = fakeQuery([{ tool: "Bash", input: { command: "rm -rf /" } }]);
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async (r) => ((reason = r), "deny") },
    { query: q },
  );
  expect(reason).toContain("rm");
  expect(decisions[0].behavior).toBe("deny");
});

test("runOrder lets the human approve an escalated tool (allow, with updatedInput)", async () => {
  const { q, decisions } = fakeQuery([{ tool: "Bash", input: { command: "git push" } }]);
  await runOrder(
    order(),
    { onMessage: () => {}, onEscalation: async () => "allow" },
    { query: q },
  );
  expect(decisions[0].behavior).toBe("allow");
  expect(decisions[0].updatedInput).toEqual({ command: "git push" });
});
