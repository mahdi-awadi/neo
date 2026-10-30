/** What a pin's Open shows (ADR-0071): the item itself, with everything the operator needs to act on it —
 *  a decision's full question, options and card; a plan card's plan, its state, its actions and the file to
 *  read; an attention item explained, with its own actions and, for a `decision_stale` reminder, the
 *  decision it is about. Plain reads over the ledger, no AI, no file I/O (the plan file is read through
 *  /md-file, ADR-0046). A todo is not here: the console has its own todo sheet. */
import { join } from "node:path";
import type { DecisionRow, Ledger } from "./ledger";
import { answerable } from "./decision-settle";
import { parseRef, staleDecisionOf } from "./needs-you";
import { planActions, planState, type PlanAction, type PlanState } from "./plans";
import { attentionView, type AttentionItemView } from "./project-view";

export interface DecisionView {
  id: string;
  kind: DecisionRow["kind"];
  status: DecisionRow["status"];
  /** Open (or expired, ADR-0053): an answer is still taken. */
  answerable: boolean;
  project?: string;
  question: string;
  options?: string[];
  spec?: DecisionRow["spec"];
  threadId?: number;
  createdAt: number;
  answer?: string;
}

export interface PlanCardView {
  id: number;
  version: number;
  title: string;
  project: string;
  state: PlanState;
  actions: PlanAction[];
  /** The plan file as the worker wrote it (relative to the project), and its absolute path for /md-file. */
  path: string;
  file: string;
}

export type ItemDetail =
  | { type: "decision"; decision: DecisionView }
  | { type: "plan"; decisionId: string; answerable: boolean; question: string; plan: PlanCardView }
  | { type: "attention"; attention: AttentionItemView; linked?: Exclude<ItemDetail, { type: "attention" }> };

export interface ItemDetailDeps {
  ledger: Pick<Ledger, "decisionById" | "planByCard" | "attentionById" | "listPins">;
}

function decisionView(d: DecisionRow): DecisionView {
  return {
    id: d.id,
    kind: d.kind,
    status: d.status,
    answerable: answerable(d),
    ...(d.project ? { project: d.project } : {}),
    question: d.question,
    ...(d.options?.length ? { options: d.options } : {}),
    ...(d.spec ? { spec: d.spec } : {}),
    ...(d.cause?.threadId !== undefined ? { threadId: d.cause.threadId } : {}),
    createdAt: d.createdAt,
    ...(d.answer !== undefined ? { answer: d.answer } : {}),
  };
}

function decisionDetail(deps: ItemDetailDeps, id: string): Exclude<ItemDetail, { type: "attention" }> | undefined {
  const d = deps.ledger.decisionById(id);
  if (!d) return undefined;
  const p = deps.ledger.planByCard(d.id);
  if (!p) return { type: "decision", decision: decisionView(d) };
  return {
    type: "plan",
    decisionId: d.id,
    answerable: answerable(d),
    question: d.question,
    plan: { id: p.id, version: p.version, title: p.title, project: p.project, state: planState(p), actions: planActions(p), path: p.path, file: join(p.folder, p.path) },
  };
}

/** The item a pin ref names, or undefined (a bad ref, a gone item, or a todo). */
export function itemDetail(deps: ItemDetailDeps, ref: string, now: number): ItemDetail | undefined {
  const target = parseRef(ref);
  if (!target) return undefined;
  if (target.type === "dec") return decisionDetail(deps, target.id);
  if (target.type !== "att") return undefined;
  const r = deps.ledger.attentionById(target.id);
  if (!r) return undefined;
  const pinned = deps.ledger.listPins().some((p) => p.ref === ref && p.state === "pinned");
  const stale = staleDecisionOf(r, deps.ledger);
  const linked = stale ? decisionDetail(deps, stale) : undefined;
  return { type: "attention", attention: attentionView(r, now, pinned), ...(linked ? { linked } : {}) };
}
