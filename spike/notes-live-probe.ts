// Throwaway probe (ADR-0050 P0). Not imported by src/. Proves on the installed SDK:
//  1. a user message pushed with priority "next" mid-turn reaches the model before the turn ends;
//  2. resume + forkSession on an idle session answers from its history, with a new id, leaving it intact.
// Run: bun spike/notes-live-probe.ts <emptyTmpDir>
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: notes-live-probe.ts <emptyTmpDir>");
for (let i = 1; i <= 6; i++) writeFileSync(join(dir, `f${i}.txt`), `file ${i}\n`);
mkdirSync(join(dir, ".claude"), { recursive: true });

type U = { type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null; priority?: "now" | "next" | "later"; session_id: string };
const user = (content: string, priority?: U["priority"]): U => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", ...(priority ? { priority } : {}) });

function channel() {
  const q: U[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(m: U) { q.push(m); wake?.(); },
    close() { closed = true; wake?.(); },
    async *iter() {
      for (;;) {
        while (q.length) yield q.shift()!;
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    },
  };
}

const base = {
  cwd: dir,
  settingSources: [] as never[],
  maxTurns: 30,
  allowedTools: ["Read"],
  canUseTool: async (_n: string, input: Record<string, unknown>) => ({ behavior: "allow" as const, updatedInput: input }),
};

// --- 1. priority "next" mid-turn
const ch = channel();
ch.push(user("Read each of f1.txt .. f6.txt ONE AT A TIME with the Read tool (six separate calls), then reply with one line listing their contents. If at any point you are told a PROBE code, include it in your final line."));
let toolUses = 0, pushed = false, sessionId = "", final = "", pushedAtTool = 0, seenInTurn = false, turns = 0;
for await (const m of query({ prompt: ch.iter() as never, options: base })) {
  if (m.type === "system" && (m as { subtype?: string }).subtype === "init") sessionId = (m as { session_id: string }).session_id;
  if (m.type === "assistant") {
    for (const b of (m as { message: { content: Array<{ type: string; text?: string }> } }).message.content) {
      if (b.type === "tool_use") toolUses++;
      if (b.type === "text" && b.text?.includes("PROBE-7731")) seenInTurn = true;
    }
    if (toolUses >= 1 && !pushed) { pushed = true; pushedAtTool = toolUses; ch.push(user("PROBE-7731: remember this code and include it in your final line.", "next")); }
  }
  if (m.type === "result") { turns++; final = (m as { result?: string }).result ?? ""; ch.close(); }
}
console.log(JSON.stringify({ probe: "priority-next", sessionId, toolUses, pushedAtTool, turns, finalHasCode: final.includes("PROBE-7731"), seenInTurn, final: final.slice(0, 300) }));

// --- 2. fork an idle session
let forkId = "", forkAnswer = "";
for await (const m of query({ prompt: "Without using any tool: which files did you read earlier in this conversation, and what PROBE code were you given? One line.", options: { ...base, resume: sessionId, forkSession: true, maxTurns: 2 } })) {
  if (m.type === "system" && (m as { subtype?: string }).subtype === "init") forkId = (m as { session_id: string }).session_id;
  if (m.type === "result") forkAnswer = (m as { result?: string }).result ?? "";
}
console.log(JSON.stringify({ probe: "fork-idle", parent: sessionId, forkId, newId: forkId !== "" && forkId !== sessionId, answer: forkAnswer.slice(0, 300) }));

// --- 2b. the parent is unchanged: resume it (no fork) and ask whether it saw the fork's question
let parentAnswer = "";
for await (const m of query({ prompt: "Without using any tool: in this conversation, were you asked 'which files did you read earlier'? Answer yes or no only.", options: { ...base, resume: sessionId, maxTurns: 2 } })) {
  if (m.type === "result") parentAnswer = (m as { result?: string }).result ?? "";
}
console.log(JSON.stringify({ probe: "parent-intact", answer: parentAnswer.slice(0, 100) }));
