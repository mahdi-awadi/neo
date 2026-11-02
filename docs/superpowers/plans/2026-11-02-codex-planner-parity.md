# Codex planner and capability parity

Goal: let Codex use a separately configured planning/review model while a different Codex model implements, retaining Neo's project and customer boundaries.

- [x] Trace Claude planner injection, Codex run lifecycle, and SDK compatibility; check account/model availability.
- [x] Upgrade the pinned Codex SDK to the version required by the chosen models and verify native role configuration against the real CLI.
- [x] Add failing tests for provider/path scoping, native planner role config and cleanup across one-shot and resumed turns, and failure behavior.
- [x] Implement turn-scoped planner role configuration using the Codex SDK and the existing worker profile, and expose configurable planner model/effort separately from Claude.
- [x] Surface Codex subagent activity; give each worker and planner its own authenticated Neo MCP session without changing the sandbox or provider switch.
- [x] Test with fake SDK events and a real disposable two-turn Codex run: GPT-6.1 Sol and GPT-6 Astra each called a Neo tool in both turns. Verify the planner is absent on read-only and unrelated paths.
- [x] Run TypeScript, full tests and diff checks; configure the verified account models.
- [ ] Run the security hook, commit only this work and restart Neo.
- [x] Document remaining SDK differences, including external MCP and tool approvals, without claiming unsupported parity.
