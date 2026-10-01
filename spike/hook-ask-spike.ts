import { query } from "@anthropic-ai/claude-agent-sdk";
const mode = process.env.HOOK_MODE!; // ask | throw | none
const calls: string[] = []; const results: string[] = [];
const hook = async (input: any) => {
  if (mode === "throw") throw new Error("boom");
  if (mode === "none") return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "spike" } };
};
const q = query({ prompt: "Run exactly this one Bash command once and report output: git log -1 --format=force", options: {
  cwd: "/tmp/team-test", settingSources: ["user","project"], permissionMode: "default", model: "claude-haiku-4-5", maxTurns: 3,
  hooks: { PreToolUse: [{ hooks: [hook] }] },
  canUseTool: async (t: string, i: any) => (calls.push(t), { behavior: "deny" as const, message: "denied by spike canUseTool" }),
}});
for await (const m of q as any) if (m.type === "user" && Array.isArray(m.message?.content)) for (const b of m.message.content) if (b.type === "tool_result") results.push(JSON.stringify(b.content).slice(0,120));
console.log(mode, JSON.stringify({ canUseToolCalls: calls, results }));
