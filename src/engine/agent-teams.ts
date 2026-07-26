// Opt-in "team mode" for a dispatch: a lead worker orchestrates named `backend` + `frontend`
// subagents (Claude Agent SDK `agents`). Proven GO by spike/agent-team-spike-findings.md —
// subagents spawn, each subagent's Write/Edit re-enters the session's canUseTool so the path-fence
// still holds, and they coordinate through a shared CONTRACT FILE the backend writes and the
// frontend builds against. NOT via SendMessage: the headless SDK does not expose inter-agent
// messaging (verified — the tool errors "not enabled in this context").
//
// This module is inert unless a dispatch asks for it: attaching `frontendBackend` + wrapping a
// brief with `teamLeadPreamble` is entirely driven by dispatch's opt-in `team` flag, so the default
// single-worker path is unchanged.
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

/** The tools each teammate gets: read/search the repo, write/edit code, run the toolchain.
 *  Deliberately the same governed set a normal worker has — the governor + path-fence still judge
 *  every call, so a teammate can no more escape the project folder than a lone worker can. */
const TEAM_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"];

/** Server-side engineer: owns APIs, data models, migrations, and the shared contract file. */
const backend: AgentDefinition = {
  description:
    "Backend engineer. Owns the server side: HTTP/RPC APIs, data models, business logic, " +
    "database schema + migrations, and the shared API contract file the frontend builds against.",
  tools: [...TEAM_TOOLS],
  model: "inherit", // no per-team model override — follow the dispatch worker's model
  prompt:
    "You are the BACKEND engineer on a two-person team (you and a `frontend` agent). Own the " +
    "server side: APIs, data models, business logic, migrations. FIRST write or extend the shared " +
    "API contract file the lead names, then implement against it. Stay strictly inside the files " +
    "the lead assigned to you — never edit the frontend's files. You cannot message the frontend " +
    "directly (no inter-agent messaging is available); the contract file IS your hand-off. Make the " +
    "smallest change that satisfies the brief and leave the build/tests green before reporting back " +
    "to the lead with a one-line summary of what you changed and where the contract lives.",
};

/** Client-side engineer: owns UI/client code and consumes the backend's contract. */
const frontend: AgentDefinition = {
  description:
    "Frontend engineer. Owns the client side: UI, components, client-side state, and the API " +
    "client code that consumes the backend's shared API contract.",
  tools: [...TEAM_TOOLS],
  model: "inherit",
  prompt:
    "You are the FRONTEND engineer on a two-person team (you and a `backend` agent). Own the client " +
    "side: UI, components, and the client code that calls the API. Build STRICTLY against the shared " +
    "API contract file the backend wrote — read it for the interface; do not invent endpoints or " +
    "edit backend files. You cannot message the backend directly (no inter-agent messaging is " +
    "available); the contract file is the interface between you. Make the smallest change that " +
    "satisfies the brief and leave the build/tests green before reporting back to the lead with a " +
    "one-line summary of what you built.",
};

/** The opt-in frontend+backend team, handed to the SDK as `agents` for a team dispatch. */
export const frontendBackend: Record<string, AgentDefinition> = { backend, frontend };

/**
 * Prefix a brief with lead-orchestration instructions for the frontend+backend team: delegate by
 * domain, enforce non-overlapping FILE OWNERSHIP boundaries, coordinate through a shared contract
 * file (since direct agent-to-agent messaging is NOT available), then sequence + integrate. The
 * original `task` is appended verbatim and returned last, so it survives intact.
 */
export function teamLeadPreamble(task: string): string {
  return (
    "You are the LEAD of a two-engineer team for this task: a `backend` agent and a `frontend` " +
    "agent (both available via the Agent tool). Orchestrate them — do NOT do their coding yourself.\n\n" +
    "RULES:\n" +
    "1. DELEGATE BY DOMAIN — send backend/API/server/database work to the `backend` agent, and " +
    "UI/client/frontend work to the `frontend` agent.\n" +
    "2. FILE OWNERSHIP — give each agent an explicit, NON-OVERLAPPING set of paths it owns and may " +
    "write; the other agent must never touch those files. State the boundary in each agent's brief " +
    "so their writes can never collide.\n" +
    "3. COORDINATE VIA A SHARED CONTRACT FILE — direct agent-to-agent messaging is NOT available. " +
    "Have the `backend` agent write a shared contract file (e.g. an API contract / interface file) " +
    "FIRST; then have the `frontend` agent build against that file. Relay any status between them " +
    "yourself.\n" +
    "4. SEQUENCE + INTEGRATE — run the backend first so the contract exists, then the frontend; " +
    "finally verify the pieces fit (build + tests green) and report one concise summary.\n\n" +
    "THE TASK:\n" +
    task
  );
}
