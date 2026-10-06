// Sanity check for governor-bypass-probe.ts: with NO canUseTool, is the project allow rule effective?
// If the command runs here but the probe saw canUseTool for it, the allow rule is honored yet does
// not pre-empt canUseTool (the bypass does not reproduce). Usage: PROBE_DIR=<folder with settings>.
import { query } from "@anthropic-ai/claude-agent-sdk";
const cwd = process.env.PROBE_DIR!;
const cmd = process.env.PROBE_CMD ?? "git log -1 --format=force";
const withCallback = process.env.WITH_CALLBACK === "1";
const calls: string[] = [];
const results: string[] = [];
const q = query({
  prompt: `Run exactly this one Bash command, once, then report its raw output verbatim. Do not run anything else: ${cmd}`,
  options: {
    cwd,
    settingSources: ["user", "project"],
    permissionMode: "default",
    model: "claude-haiku-4-5",
    maxTurns: 4,
    ...(withCallback
      ? { canUseTool: async (t: string, i: Record<string, unknown>) => (calls.push(`${t}: ${JSON.stringify(i)}`), { behavior: "allow" as const, updatedInput: i }) }
      : {}),
  },
});
for await (const m of q as AsyncIterable<any>) {
  if (m.type === "user" && Array.isArray(m.message?.content))
    for (const b of m.message.content) if (b.type === "tool_result") results.push(JSON.stringify(b.content).slice(0, 200));
}
console.log(JSON.stringify({ cwd, cmd, withCallback, canUseToolCalls: calls, toolResults: results }, null, 2));
