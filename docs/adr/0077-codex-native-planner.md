# ADR-0077: A native Codex planner role

## Context

Neo's Claude workers use an SDK planner subagent with a model distinct from the implementation
worker. The Codex adapter drops Claude `AgentDefinition` objects, so its project workers could not
perform the equivalent handoff. The pinned 0.145 Codex SDK also rejects this account's GPT-6 models.

## Decision

Upgrade the pinned Codex SDK to 0.166. When `workerEnv.NEO_CODEX_PLANNER_MODEL` is set, project,
dispatch and loop workers receive a native Codex `planner` role; `NEO_CODEX_PLANNER_EFFORT` controls
its reasoning effort, defaulting to `high`. `NEO_CODEX_MODEL` independently chooses the worker.
No role is supplied to company, consult, judge, ingress, or read-only runs. Without an explicit
planner model the behavior remains unchanged.

A daemon-private, per-turn role file carries the model, effort and existing planner instructions.
It is removed after the CLI process exits, including on errors, and recreated for resumed turns.
Neo includes an explicit delegation request in each applicable task and instructs the worker to wait;
Codex's agent policy requires a user-level delegation request. The request permits a more specific
operator instruction to override it. The model and SDK choose whether to call the role. This follows the existing Claude planner contract
rather than claiming a deterministic extra phase. Native agent activity is forwarded to Neo.

## Verification and limits

With local ChatGPT authentication, a disposable Neo SDK design request used GPT-6.1 Sol for the main
worker and spawned a planner whose recorded model was GPT-6 Astra. Model availability remains account-specific.
The role inherits the parent's Codex sandbox; it does not grant external MCP access. The SDK does not
provide Claude's per-tool governor, arbitrary Claude agent definitions, or full team-dispatch parity.
Keep those limitations visible and do not enable unsafe ambient capabilities as a substitute.

Each client using a Neo MCP capability within the turn receives its own server and MCP session.
Sharing one stateful transport caused a planner's initialization to fail after the worker connected;
the bridge keeps independent sessions under the same authenticated turn-scoped listener.

A separate engine-run planner was rejected because it would force extra calls on simple requests and
lose the lead agent's context. Treating model output as proof that delegation occurred was rejected;
the real-run check inspected the subagent's own session model.
