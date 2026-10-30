// What an attention item is, in a form the operator can read (ADR-0059): a kind badge, a plain one-line
// title without raw prefixes ("PR #31:", "thread waiting 2d:"), the facts its description is built from,
// its links, and exactly what → todo would send. Deterministic, no I/O, never throws. It produces no prose
// of its own: the console renders the badge, the description and the next step from its locale catalogues
// (`att.*`), filled with these facts, so the same item reads right in English and Arabic.
import type { AttentionFacts, AttentionRow } from "./ledger";
import { attentionBrief } from "./attention-briefs";
import { CODED_FACTS, factsOf } from "./attention-facts";
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
  /** Every fact the reason template names is there; false → the item's own title is the reason. */
  reasonOk: boolean;
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
  history_off: ["step"], history_degraded: ["step"],
};

export function explainAttention(row: AttentionRow): AttentionExplain {
  const facts: AttentionFacts = factsOf(row);
  // A badge is a kind the EN catalogue names (`att.kind.*`); any other kind reads as "other".
  let badge = enKinds()[row.kind] !== undefined ? row.kind : "other";
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
  const out = { badge, project: row.project, plain: plain.trim() || row.title, facts, links, ...(brief ? { brief } : {}) };
  return { ...out, reasonOk: reasonComplete(out) };
}

type AttCatalogue = { att?: { kind?: Record<string, string>; why?: Record<string, string> } };

/** A coded fact's English text (`CODED_FACTS`), from the EN catalogue; undefined when it has none. */
function codedEn(badge: string, fact: string, value: string | number): string | undefined {
  const section = CODED_FACTS[badge]?.[fact];
  if (!section) return undefined;
  let node: unknown = EN;
  for (const part of [...section.split("."), String(value)]) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  return typeof node === "string" ? node : undefined;
}
const enKinds = (): Record<string, string> => (EN as AttCatalogue).att?.kind ?? {};

/** A badge's English name, from the console's EN catalogue (`att.kind.*`); the badge key when absent. */
export function badgeLabel(badge: string): string {
  const kinds = enKinds();
  return kinds[badge] ?? kinds.other ?? badge;
}

/** Facts that are references, shown as "#N". */
const REFS = new Set(["pr", "issue", "alert", "decision"]);

/** True when the item has every fact its reason template names (the EN and AR templates name the same ones):
 *  a reason with a gap is not shown — the item's own title stands in (an older row, before its next scan). */
export function reasonComplete(e: Pick<AttentionExplain, "badge" | "facts">): boolean {
  const tpl = (EN as AttCatalogue).att?.why?.[e.badge] ?? "";
  return [...tpl.matchAll(/\{\{(\w+)\}\}/g)].every(([, k]) => (k === "age" ? typeof e.facts.since === "number" : e.facts[k!] !== undefined && e.facts[k!] !== ""));
}

/** The item's reason in English (the EN catalogue's `att.why.<badge>`, filled from its facts), for Telegram:
 *  the same template the console renders; "" when a fact it names is missing. */
export function whyEn(e: Pick<AttentionExplain, "badge" | "facts">, now: number): string {
  if (!reasonComplete(e)) return "";
  const tpl = (EN as AttCatalogue).att?.why?.[e.badge] ?? "";
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (k === "age") return typeof e.facts.since === "number" ? shortAge(now - e.facts.since) : "?";
    const v = e.facts[k];
    if (v === undefined || v === "") return "?";
    const coded = codedEn(e.badge, k, v);
    if (coded !== undefined) return coded;
    return REFS.has(k) ? `#${v}` : k === "pct" ? `${v}%` : String(v);
  });
}

/** "45m", "7h", "3d". */
function shortAge(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
