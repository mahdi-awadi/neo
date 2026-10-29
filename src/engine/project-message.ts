// `project_message` (ADR-0061): the chief of staff speaks to a project's open session the way the operator
// does when they switch to it and type — the same delivery (`deliverToSession`: a steer into a live run,
// a resume of an idle one). It is for "resume", "status?", "continue"; new work stays `dispatch`, and
// information for another project stays `project_notes`. The agent decides when to use it; the code enforces
// what it may do: own work only (a customer session is refused), a short text, a main-lane session that is
// open, never the company itself, and a per-project rate limit. Every delivered message is marked: a
// `project_message` event (never the text) and a line "chief of staff → <project>" in the project's stream
// and the operator's thread.
import { join, resolve } from "node:path";
import type { Cause } from "./ledger";
import { CUSTOMER_CHAT } from "./ingress";
import { deliverToSession, type DeliverOutcome, type PipelineDeps } from "./pipeline";
import { startOrder } from "./session-runner";
import { faults } from "./fault";
import { readProjectMessageCfg } from "./project-message-cfg";
export { DEFAULT_PROJECT_MESSAGE_CFG, readProjectMessageCfg, type ProjectMessageCfg } from "./project-message-cfg";

export interface ProjectMessageResult {
  ok: boolean;
  outcome?: DeliverOutcome["kind"];
  /** What to tell the agent. */
  text: string;
}

const HOUR_MS = 3_600_000;
/** Folders with a delivery in progress: parallel calls in one turn cannot pass the rate limit together. */
const inFlight = new Set<string>();
const NAME_RE = /^[\w][\w.-]*$/;

export async function sendProjectMessage(
  deps: PipelineDeps,
  a: { project: string; text: string; replyChat: number; cause?: Cause },
): Promise<ProjectMessageResult> {
  const cfg = readProjectMessageCfg(deps.cfg.projectMessage);
  const now = deps.now ?? (() => Date.now());
  const refuse = (text: string): ProjectMessageResult => ({ ok: false, text: `project_message refused: ${text}` });
  const text = a.text.trim();
  if (!text) return refuse("the message is empty");
  if (text.length > cfg.maxChars) return refuse(`${text.length} chars is more than a message (at most ${cfg.maxChars}) — new work goes through dispatch`);
  const name = a.project.trim();
  if (!NAME_RE.test(name)) return refuse(`${JSON.stringify(a.project)} is not a project name`);
  const { registry } = deps;
  // A main-lane session only: side lanes are single-brief (ADR-0057), and findByFolder skips them.
  const s = registry.findByFolder(resolve(join(deps.cfg.workRoot, name))) ?? registry.list().find((x) => x.name === name && !x.lane && (x.status === "running" || x.status === "idle"));
  if (!s) return refuse(`${name} has no open session — new work or a fresh start goes through dispatch`);
  if (s.id === registry.getDefault()?.id) return refuse("that is the company itself");
  // Own work only (the compliance firewall): a session a customer-driven run used stays fenced — the
  // agent's words would resume it with the operator's own tools.
  if (s.customerDriven || s.order.source !== "neo" || s.order.chatId === CUSTOMER_CHAT) return refuse(`${s.name} is a customer-driven session — the chief of staff never speaks into it`);
  const project = s.name;
  const folder = s.order.folder;
  const control = registry.getControl(s.id);
  // Still starting: the dispatch that opened it attaches its run soon; a resume now would start a second run.
  if (s.status === "running" && !control) return refuse(`${project} is still starting — try again in a moment`);
  // Closing: never wait for it here (the company's own turn would hang); the operator path waits, the tool does not.
  if (control?.closed?.() === true) return refuse(`${project} is closing — try again in a moment`);
  // Held at a big plan (ADR-0052): it takes no brief until the operator approves the plan.
  const plan = control?.held?.();
  if (plan !== undefined) return refuse(`${project} is held at a big plan waiting for the operator's approval (${plan}) — tell the operator`);
  // Waiting for the operator's own answer (ask_operator): never answer a decision for them.
  if (s.blockedOn?.kind === "decision") return refuse(`${project} waits for the operator's answer to "${s.blockedOn.label}" — tell the operator, do not answer it yourself`);
  // One delivery at a time per project, counted by folder (a re-opened "<name>-2" is the same project).
  if (inFlight.has(folder)) return refuse(`a message to ${project} is being delivered — wait for its result`);
  const used = deps.ledger.countEvents({ kind: "project_message", folder, since: now() - HOUR_MS });
  if (used >= cfg.perProjectPerHour) return refuse(`${project} already got ${used} messages in the last hour (at most ${cfg.perProjectPerHour}) — wait, or tell the operator`);

  // The run held in an API wait is the folder's running todo's order (a reused session's first order is not).
  const running = deps.ledger.listTodos({ folder, statuses: ["running"], limit: 1 })[0];
  const held = deps.apiWaits?.held(running?.orderId ?? s.order.id) ?? deps.apiWaits?.held(s.order.id);
  inFlight.add(folder);
  let out: DeliverOutcome;
  try {
    out = await deliverToSession(s, text, a.replyChat, deps, a.cause, { now, start: deps.start ?? startOrder });
  } finally {
    inFlight.delete(folder);
  }
  if (out.kind === "closing") return refuse(`${project} is closing — try again in a moment`);
  if (out.kind === "reopening") return refuse(`${project} is reopening — try again in a moment`);
  if (out.kind === "resumed") void out.run.catch((e) => faults.report("projectMessage.resume", e, { project }));

  try {
    deps.ledger.recordEvent("project_message", { folder, orderId: s.order.id, cause: a.cause, data: { project, chars: text.length, outcome: out.kind, ...(held ? { held: held.kind } : {}) } });
  } catch { /* the trail never undoes a delivery */ }
  // The operator sees every one: in the project's stream, and in the thread the agent's turn answers.
  await deps.reply(a.replyChat, `🤖 chief of staff → ${project}: ${text}`, project, undefined, { kind: "agent_message", ...(a.cause ? { cause: a.cause } : {}) });

  const said =
    out.kind === "resumed"
      ? `delivered to ${project}: its idle session woke with your message (its replies go to the operator's stream, not back to you)`
      : held
        ? `delivered to ${project}: it was held in a ${held.kind === "rate_limit" ? "limit wait" : "API retry wait"} — your message starts a turn now`
        : out.midTurn
          ? `delivered to ${project}: it sees your message at its next step`
          : `delivered to ${project}: it runs your message after its current turn`;
  return { ok: true, outcome: out.kind, text: said };
}
