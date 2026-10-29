// What an attention item is, in a form the operator can read (ADR-0059): a kind badge, a plain one-line
// title without raw prefixes ("PR #31:", "thread waiting 2d:"), the facts its description is built from,
// its links, and exactly what → todo would send. Deterministic, no I/O, never throws. It produces no prose
// of its own: the console renders the badge, the description and the next step from its locale catalogues
// (`att.*`), filled with these facts, so the same item reads right in English and Arabic.
import type { AttentionFacts, AttentionRow } from "./ledger";
import { attentionBrief, ATTENTION_BRIEFS } from "./attention-briefs";
import { factsOf } from "./attention-facts";
// The console's EN catalogue is the one source of badge names; Telegram (English) reads the same text.
import EN from "../frontends/web/locales/en/console.json";

export interface AttentionLink {
  kind: "pr" | "issue" | "url" | "branch" | "thread";
  label: string;
  href?: string;
}

export interface AttentionExplain {
  /** A catalogue key suffix (`att.kind.<badge>`): the item's kind, `dep_update_pr` for a dependency PR, `other` for an unknown kind. */
  badge: string;
  /** The project (repo) the item belongs to. */
  project: string;
  /** A plain one-line title. */
  plain: string;
  facts: AttentionFacts;
  links: AttentionLink[];
  /** Exactly what → todo sends; undefined when the kind has no brief (→ todo is refused). */
  brief?: string;
}

/** A PR title, plain: a repeated scope `(x)(x)` collapsed, a conventional prefix (`chore(deps):`) dropped,
 *  a Dependabot "bump X from A to B" read as "X A → B". */
export function plainPrTitle(raw: string): { title: string; dep?: { name: string; from: string; to: string } } {
  let t = raw.trim().replace(/(\([^()]*\))\1+/g, "$1");
  t = t.replace(/^[a-z]+(\([^()]*\))?!?:\s*/i, "");
  const bump = /^bump (\S+) from (\S+) to (\S+)/i.exec(t);
  if (bump) return { title: `${bump[1]} ${bump[2]} → ${bump[3]}`, dep: { name: bump[1]!, from: bump[2]!, to: bump[3]! } };
  return { title: t ? t[0]!.toUpperCase() + t.slice(1) : raw };
}

/** The fact that names each kind's subject, in order of preference. */
const SUBJECT: Record<string, string[]> = {
  pr_review_requested: ["prTitle"], issue_open: ["issueTitle"], ci_failed: ["workflow"],
  dependabot: ["summary"], code_scanning: ["summary"], secret_scanning: ["secretType"],
  unpushed: ["branch"], no_upstream: ["branch"], stale_branch: ["branch"], drift: ["branch"], worktree: ["path"],
  thread_waiting: ["threadTitle"], thread_failed: ["threadTitle"], decision_stale: ["question"],
  approval_stuck: ["label"], dispatch_spinning: ["label"], queue_paused: ["reason"],
};

export function explainAttention(row: AttentionRow): AttentionExplain {
  const facts: AttentionFacts = factsOf(row);
  let badge = ATTENTION_BRIEFS[row.kind] || SUBJECT[row.kind] || row.kind === "pr_open" ? row.kind : "other";
  let plain = row.title;
  if (row.kind === "pr_open" && typeof facts.prTitle === "string") {
    const p = plainPrTitle(facts.prTitle);
    plain = p.title;
    if (p.dep) {
      badge = "dep_update_pr";
      Object.assign(facts, { dep: p.dep.name, from: p.dep.from, to: p.dep.to });
    }
  } else if (row.kind === "pr_review_requested" && typeof facts.prTitle === "string") {
    plain = plainPrTitle(facts.prTitle).title;
  } else {
    const key = SUBJECT[row.kind]?.find((k) => facts[k] !== undefined && facts[k] !== "");
    if (key) plain = String(facts[key]);
  }
  const links: AttentionLink[] = [];
  if (facts.pr !== undefined) links.push({ kind: "pr", label: `PR #${facts.pr}`, ...(row.url ? { href: row.url } : {}) });
  else if (facts.issue !== undefined) links.push({ kind: "issue", label: `#${facts.issue}`, ...(row.url ? { href: row.url } : {}) });
  else if (row.url) links.push({ kind: "url", label: row.url, href: row.url });
  if (typeof facts.branch === "string" && row.kind !== "ci_failed") links.push({ kind: "branch", label: facts.branch });
  if (facts.thread !== undefined) links.push({ kind: "thread", label: `#${facts.thread}` });
  let brief: string | undefined;
  try {
    brief = attentionBrief(row);
  } catch {
    brief = undefined;
  }
  return { badge, project: row.project, plain: plain.trim() || row.title, facts, links, ...(brief ? { brief } : {}) };
}

/** A badge's English name, from the console's EN catalogue (`att.kind.*`); the badge key when absent. */
export function badgeLabel(badge: string): string {
  const kinds = (EN as { att?: { kind?: Record<string, string> } }).att?.kind ?? {};
  return kinds[badge] ?? kinds.other ?? badge;
}
