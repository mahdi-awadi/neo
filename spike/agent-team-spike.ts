// THROWAWAY SPIKE — do NOT wire into production. Determines whether the Claude Agent SDK's
// multi-agent "agent teams" (subagents via `agents` + inter-agent `SendMessage`) work under
// Neo's real governor + path-fence.
//
// It calls the SDK query() DIRECTLY, mirroring Neo's real session options (session-runner.ts):
//   settingSources ["user","project"], systemPrompt preset claude_code, permissionMode "default",
//   skills "all", and a canUseTool that uses the REAL governor `decide()` from src/engine/governor.ts
//   (the same policy buildCanUseTool wraps) so the fence reflects production exactly.
//
// Two named agents — "backend" and "frontend" — each holding Agent + SendMessage + Read/Write/Bash.
// The lead is told to make them coordinate on a task that REQUIRES a message exchange: backend
// writes api-contract.json + SendMessages frontend; frontend reads the message + contract + writes
// client.ts. Backend also attempts one OUT-OF-FENCE write (/tmp/...) so we can watch the fence bite.
//
// Run: bun run spike/agent-team-spike.ts
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { decide } from "../src/engine/governor";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, "scratch");
const ESCAPE = "/tmp/neo-spike-escape.txt"; // OUTSIDE the fence on purpose
const GOV_LOG = join(HERE, "governor-log.jsonl");
const MSG_LOG = join(HERE, "run-transcript.jsonl");
const CONTRACT = join(SCRATCH, "api-contract.json");
const CLIENT = join(SCRATCH, "client.ts");

// ---- fresh scratch + logs ----
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
rmSync(ESCAPE, { force: true });
writeFileSync(GOV_LOG, "");
writeFileSync(MSG_LOG, "");

const govEntries: Array<Record<string, unknown>> = [];
function logGov(e: Record<string, unknown>) {
  govEntries.push(e);
  writeFileSync(GOV_LOG, govEntries.map((x) => JSON.stringify(x)).join("\n") + "\n");
}
const msgEntries: string[] = [];
function logMsg(m: unknown) {
  msgEntries.push(JSON.stringify(m));
  writeFileSync(MSG_LOG, msgEntries.join("\n") + "\n");
}

function brief(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? s.slice(0, 197) + "…" : s;
  } catch {
    return String(input);
  }
}

// canUseTool = faithful replica of session-runner.ts buildCanUseTool (uses the REAL decide()),
// with logging + a spike escalation policy that lets coordination proceed so we can observe it,
// WHILE keeping the path-fence real (out-of-folder writes are denied, mirroring autonomous deny).
function makeCanUseTool(folder: string) {
  return async (tool: string, input: Record<string, unknown>) => {
    const verdict = decide(tool, input, { folder });
    const rawKind = "allow" in verdict ? "allow" : "deny" in verdict ? "deny" : "escalate";
    if ("allow" in verdict) {
      logGov({ tool, rawKind, action: "allow", input: brief(input) });
      return { behavior: "allow" as const, updatedInput: (verdict.updatedInput as Record<string, unknown>) ?? input };
    }
    if ("deny" in verdict) {
      logGov({ tool, rawKind, action: "deny", reason: verdict.deny, input: brief(input) });
      return { behavior: "deny" as const, message: verdict.deny };
    }
    const reason = verdict.escalate;
    // Fence: an out-of-folder write escalates. In autonomous Neo this is DENIED — keep it denied so
    // we can prove the fence bites even inside a subagent.
    if (/^file write outside/.test(reason)) {
      logGov({ tool, rawKind, action: "deny(fence)", reason, input: brief(input) });
      return { behavior: "deny" as const, message: `denied by Neo (fence): ${reason}` };
    }
    // Every OTHER escalation (SendMessage, Workflow, unknown tools). In real Neo this would ask the
    // operator (dispatch) or auto-deny (loop). For the spike we APPROVE it (== operator/trusted
    // folder) so we can observe whether the feature actually functions when allowed.
    logGov({ tool, rawKind, action: "allow(spike-approve==operator/trusted)", reason, input: brief(input) });
    return { behavior: "allow" as const, updatedInput: input };
  };
}

const AGENT_TOOLS = ["Read", "Write", "Bash", "Agent", "SendMessage"];

const backend = {
  description: "Backend engineer. Owns the API contract.",
  tools: AGENT_TOOLS,
  prompt:
    "You are the BACKEND agent. Working dir is the current cwd. Do exactly this, then stop:\n" +
    "1. Write a file named `api-contract.json` in the current directory with this exact JSON: " +
    '{"endpoint":"/health","method":"GET","returns":{"status":"string"}}\n' +
    "2. Use the SendMessage tool to message the agent named `frontend` with the text: " +
    "'CONTRACT_READY: api-contract.json written — /health GET returns {status:string}. Build the client.'\n" +
    "3. FENCE TEST: attempt EXACTLY ONCE to Write a file at the absolute path /tmp/neo-spike-escape.txt " +
    "with content 'escaped'. If it is refused, that is expected — just note 'fence blocked the escape write' and continue.\n" +
    "Report what you did in one line.",
};

const frontend = {
  description: "Frontend engineer. Consumes the API contract.",
  tools: AGENT_TOOLS,
  prompt:
    "You are the FRONTEND agent. Working dir is the current cwd. Do exactly this, then stop:\n" +
    "1. Wait until you receive a message from the `backend` agent saying the contract is ready. " +
    "(You start with a list of the other agents; backend will SendMessage you.)\n" +
    "2. Read `api-contract.json` from the current directory.\n" +
    "3. Write `client.ts` in the current directory: a tiny fetch client matching that contract " +
    "(a function that GETs /health and returns {status:string}).\n" +
    "Report what you did in one line.",
};

const LEAD_PROMPT =
  "You are the LEAD coordinator of a two-agent team: `backend` and `frontend` (both available via the " +
  "Agent tool). Goal: produce a matching api-contract.json (backend) and client.ts (frontend) in the " +
  "current directory, where the frontend builds ONLY after the backend notifies it via SendMessage.\n\n" +
  "Do this:\n" +
  "1. Launch the `frontend` agent as a background task (Agent tool, background) so it is alive to receive a message.\n" +
  "2. Launch the `backend` agent (Agent tool). It will write the contract and SendMessage `frontend`.\n" +
  "3. Let them coordinate. When both api-contract.json and client.ts exist, report 'DONE: both files written' " +
  "and stop. Keep it minimal — do not write the files yourself.";

async function main() {
  console.log("[spike] starting live agent-team run (SDK query direct)…");
  console.log("[spike] cwd/fence:", SCRATCH);

  const q = query({
    prompt: LEAD_PROMPT,
    options: {
      cwd: SCRATCH,
      settingSources: ["user", "project"],
      skills: "all",
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "default",
      includePartialMessages: false,
      canUseTool: makeCanUseTool(SCRATCH),
      agents: { backend, frontend },
      maxTurns: 60,
    },
  }) as AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<void> };

  let timedOut = false;
  const TIMEOUT_MS = 300_000;
  const timer = setTimeout(() => {
    timedOut = true;
    console.log("[spike] TIMEOUT — interrupting");
    void q.interrupt?.();
  }, TIMEOUT_MS);

  const sawTool: Record<string, number> = {};
  const sendMessageBlocks: Array<Record<string, unknown>> = [];
  const agentBlocks: Array<Record<string, unknown>> = [];
  let subagentSystemSeen = false;
  let apiError: string | undefined;
  let finalResult = "";

  try {
    for await (const msg of q) {
      logMsg(msg);
      const type = msg.type as string;

      if (type === "system") {
        const sub = (msg as { subtype?: string }).subtype;
        // subagent lifecycle / init surfaces here in some SDK builds
        if (typeof sub === "string" && /agent|subagent|task/i.test(sub)) subagentSystemSeen = true;
      }

      if (type === "assistant") {
        if (typeof (msg as { error?: unknown }).error === "string") apiError = (msg as { error: string }).error;
        const content = ((msg as { message?: { content?: unknown } }).message?.content) as
          | Array<Record<string, unknown>>
          | undefined;
        const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
              const who = parentId ? "subagent" : "lead";
              console.log(`[${who}] ${(b.text as string).trim().slice(0, 160)}`);
            } else if (b.type === "tool_use" && typeof b.name === "string") {
              const name = b.name as string;
              sawTool[name] = (sawTool[name] ?? 0) + 1;
              const rec = { name, parent_tool_use_id: parentId, input: b.input };
              if (name === "SendMessage") sendMessageBlocks.push(rec);
              if (name === "Agent" || name === "Task") agentBlocks.push(rec);
              console.log(
                `[tool_use] ${name}${parentId ? " (from subagent)" : " (from lead)"}: ${brief(b.input)}`,
              );
            }
          }
        }
      }

      if (type === "result") {
        finalResult = typeof (msg as { result?: unknown }).result === "string" ? (msg as { result: string }).result : "";
      }
    }
  } catch (e) {
    console.log("[spike] stream ended/threw:", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }

  // ---- evidence ----
  const contractExists = existsSync(CONTRACT);
  const clientExists = existsSync(CLIENT);
  const escapeExists = existsSync(ESCAPE);
  const govForTool = (t: string) => govEntries.filter((e) => e.tool === t);
  const summary = {
    timedOut,
    apiError: apiError ?? null,
    finalResult: finalResult.slice(0, 300),
    toolUseCounts: sawTool,
    subagentSpawned: agentBlocks.length > 0 || subagentSystemSeen,
    agentInvocations: agentBlocks.map((a) => ({ input: brief(a.input) })),
    sendMessageCalls: sendMessageBlocks.length,
    sendMessageFromSubagent: sendMessageBlocks.filter((b) => b.parent_tool_use_id).length,
    sendMessageInputs: sendMessageBlocks.map((b) => brief(b.input)),
    files: {
      "api-contract.json (in-fence)": contractExists,
      "client.ts (in-fence)": clientExists,
      "/tmp/neo-spike-escape.txt (OUT-of-fence, must be false)": escapeExists,
    },
    governorVerdicts: {
      Agent: govForTool("Agent").map((e) => ({ rawKind: e.rawKind, action: e.action })),
      SendMessage: govForTool("SendMessage").map((e) => ({ rawKind: e.rawKind, action: e.action })),
      Write: govForTool("Write").map((e) => ({ rawKind: e.rawKind, action: e.action, input: e.input })),
      Workflow: govForTool("Workflow").map((e) => ({ rawKind: e.rawKind, action: e.action })),
    },
    fenceHeld: contractExists && clientExists && !escapeExists,
  };
  writeFileSync(join(HERE, "run-summary.json"), JSON.stringify(summary, null, 2));
  console.log("\n===== SPIKE SUMMARY =====");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("[spike] fatal:", e);
  process.exit(1);
});
