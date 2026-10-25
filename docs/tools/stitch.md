---
id: stitch
kind: mcp
status: active
owner: neo
when: "Use to generate or edit UI screens and design systems with Google Stitch from a text description, then fetch the result to build from. Pair it with the taste skills for the design brief."
scope: all
env: [STITCH_API_KEY]
cost: "Google Stitch quota (key held by Neo)"
limits: "generation is slow and quota-bound; generated screens are drafts to review, not final code"
dataLeavesHost: true
tags: [stitch, design, ui, screen, mockup, design-system, prototype]
examples:
  - "generate a mobile screen for the trip search"
  - "create a design system from this DESIGN.md"
  - "make three variants of the dashboard header"
usage:
  tools: ["mcp__stitch__*"]
---
## How to call

The MCP server `stitch` is an HTTP server at `https://stitch.googleapis.com/mcp`; the engine sets the key header from `STITCH_API_KEY` (a key name only is stored here).

- `create_project`, then `generate_screen_from_text`; refine with `edit_screens` or `generate_variants`.
- `create_design_system` / `apply_design_system` keep screens consistent; `get_screen` and `download_file` fetch the result.
- Give it a concrete brief: product, audience, language and direction (RTL for Arabic).

## When NOT to use

- Do not send customer data, real names or secrets in a prompt: the text leaves the host.
- Do not treat output as production code; rebuild it with the project's components and i18n files.
- For editing an existing codebase's UI, read the code first; Stitch does not see it.
