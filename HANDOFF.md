# HANDOFF — neo

_Auto-written by Neo when this session was idle-closed (a deterministic engine note, not a
worker turn). It records where the session left off so the next run can pick up; it is
overwritten each time the session is closed._

- Folder: /home/neo
- Opening brief: Before starting, read this project's rule and doc .md files so you work by its rules: AGENTS.md, DESIGN.md, and any other root-level .md files (besides CLAUDE.md, already loaded), plus the docs relevant to this task (e.g. under docs/). Follow them together with CLAUDE.md.

REQUIRED — use the `codebase-memory` MCP FIRST. The engine has already indexed this project for you, so the structural map is ready to query. Call `list_projects` FIRST and pass the EXACT project name it returns whose `root_path` matches (or contains) your working directory — do NOT guess or construct the project name. Guessing yields "project not found": this repo may be indexed under a path-derived name, and its code can live in a subfolder indexed as its own project. Then get_architecture for the module layout with that name, then search_code / query_graph to find the code that matters. Read source files directly ONLY for what the map doesn't cover — never as your default way in.

REQUIRED — use the superpowers skills for the shape of work at hand: brainstorming → writing-plans for design, systematic-debugging to root-cause any bug, and test-driven-development for implementation (write the failing test first).

Read-only investigation of the Neo ENGINE code — change NOTHING, no edits. Report findings with file:line citations.

Context: A dispatched worker doing model-research tried to use web search, failed, misread it as "search blocked / permission denied", and concluded it should offload the search to Gemini. We are on the Claude Agent SDK and workers should have full WebSearch/WebFetch. I need to know whether the ENGINE actually routes/denies search in a way that pushes work toward Gemini, or whether this is purely a worker misreading a deferred-tool error.

Answer these questions precisely, each with file:line evidence:

1. GOVERNOR: In src/engine/governor.ts (and anything it imports), how are WebSearch and WebFetch handled? Specifically: for a dispatched/autonomous session (no interactive operator approval available), does the governor AUTO-DENY WebFetch and/or WebSearch? Quote the exact branch. Distinguish WebSearch vs WebFetch — are they treated the same? Is there a default-escalate → auto-deny path that catches them?

2. Does the governor's deny surface to the worker as a "permission denied"-type result that a worker could confuse with a tool-not-loaded error? Quote the denial message/shape.

3. PROVIDER ROUTER: In src/engine/provider-router.ts, is there ANY code path that routes SEARCH or web work to Gemini for OWN-WORK (source != "customer")? Grep for gemini/Gemini across src/. List every place Gemini is invoked and what triggers it. Confirm whether Gemini is ONLY reachable for source:"customer" (customer-direct reads) and never for the operator's own search.

4. DISPATCH PREAMBLE: In the dispatch brief/preamble the engine prepends to workers (search src/ for where the preamble/system text is built — likely dispatch.ts or session-runner.ts), is there anything that tells workers about WebSearch/WebFetch being deferred tools that must be loaded via ToolSearch first? Or anything that would mislead a worker into thinking search is unavailable / that Gemini is the fallback?

5. VERDICT: Based on the code, is the "worker went to Gemini for search" a REAL engine bug (governor auto-denies search on dispatched paths, OR router sends own-work search to Gemini), or purely a worker-side misdiagnosis with no engine cause? If it IS a real engine issue, name the exact file:line and the minimal fix — but do NOT apply it.

Keep it tight: bullet answers with citations, then the verdict. Emit progress every ~2 minutes if the read is long.
- Last activity: waiting
- Idle-closed at: 2026-08-17T01:47:00.018Z

## Outstanding
The session went quiet and was closed to free the subscription pool. If work was mid-flight,
re-read this and continue from the last activity above; otherwise treat the opening brief as done.