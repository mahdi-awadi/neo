// An attention item's facts (ADR-0059): what it is about, as data — the branch, the PR number, how many
// days. A producer writes them with the item and refreshes them on every scan. An item written before the
// facts existed (or a one-shot item a scan never refreshes) gets them derived here from its kind, key and
// title: the producers wrote those titles, so their shapes are known. Stored facts always win. A leaf
// module (types only), so the brief templates and the explain step share it.
import type { AttentionFacts, AttentionRow } from "./ledger";

type Derive = (key: string, title: string) => AttentionFacts | undefined;

const num = (s: string | undefined): number | undefined => (s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined);
const clean = (o: Record<string, string | number | undefined>): AttentionFacts => {
  const out: AttentionFacts = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") out[k] = v;
  return out;
};

/** Per kind: the facts its title and key carry (the producers' own title shapes). */
const DERIVE: Record<string, Derive> = {
  pr_open: (key, t) => {
    const m = /^PR #(\d+)( \(draft\))?: (.*)$/.exec(t);
    return clean({ pr: num(m?.[1]) ?? num(key), prTitle: m?.[3], draft: m ? (m[2] ? 1 : 0) : undefined });
  },
  pr_review_requested: (key, t) => {
    const m = /^PR #(\d+) waits for your review: (.*)$/.exec(t);
    return clean({ pr: num(m?.[1]) ?? num(key), prTitle: m?.[2] });
  },
  issue_open: (key, t) => {
    const m = /^issue #(\d+): (.*)$/.exec(t);
    return clean({ issue: num(m?.[1]) ?? num(key), issueTitle: m?.[2] });
  },
  ci_failed: (key, t) => {
    const m = /^(.*) failed on (.*)$/.exec(t);
    const [branch, workflow] = key.split(":");
    return clean({ workflow: m?.[1] ?? workflow, branch: m?.[2] ?? branch });
  },
  dependabot: (key, t) => {
    const m = /^dependabot #(\d+) \(([^)]*)\): (.*)$/.exec(t);
    return clean({ alert: num(m?.[1]) ?? num(key), severity: m?.[2], summary: m?.[3] });
  },
  code_scanning: (key, t) => {
    const m = /^code scanning #(\d+): (.*)$/.exec(t);
    return clean({ alert: num(m?.[1]) ?? num(key), summary: m?.[2] });
  },
  secret_scanning: (key, t) => {
    const m = /^secret leaked #(\d+): (.*)$/.exec(t);
    return clean({ alert: num(m?.[1]) ?? num(key), secretType: m?.[2] });
  },
  unpushed: (key, t) => {
    const m = /^(.*) is (\d+) commit\(s\) ahead of (.*)$/.exec(t);
    return clean({ branch: m?.[1] ?? key, ahead: num(m?.[2]), upstream: m?.[3] });
  },
  no_upstream: (key, t) => clean({ branch: key, gone: /upstream is gone/.test(t) ? 1 : 0 }),
  stale_branch: (key, t) => {
    const m = /^(.*): no commit for (\d+) days, not merged into (.*)$/.exec(t);
    return clean({ branch: m?.[1] ?? key, days: num(m?.[2]), base: m?.[3] });
  },
  drift: (key, t) => {
    const m = /^(.*) is (\d+) commit\(s\) ahead of (.*)$/.exec(t);
    const [a, b] = key.split("..");
    return clean({ branch: m?.[1] ?? a, ahead: num(m?.[2]), base: m?.[3] ?? b });
  },
  dirty: (_key, t) => clean({ files: num(/^(\d+) uncommitted file/.exec(t)?.[1]), todo: num(/todo #(\d+)/.exec(t)?.[1]) }),
  worktree: (key, t) => clean({ path: key, branch: /\(([^)]+)\) idle/.exec(t)?.[1], hours: num(/idle (\d+)h$/.exec(t)?.[1]) }),
  thread_waiting: (key, t) => clean({ thread: num(key), threadTitle: /^thread waiting \S+: (.*)$/.exec(t)?.[1] }),
  thread_failed: (key, t) => clean({ thread: num(key), threadTitle: /^thread failed: (.*)$/.exec(t)?.[1] }),
  decision_stale: (key, t) => clean({ decision: key.slice(0, 8), question: /^decision open \S+: (.*)$/.exec(t)?.[1] }),
  approval_stuck: (_key, t) => clean({ label: /^approval pending \S+: (.*)$/.exec(t)?.[1] }),
  dispatch_spinning: (_key, t) => clean({ label: /^repeating itself for \S+: (.*)$/.exec(t)?.[1] }),
  queue_paused: (_key, t) => clean({ reason: /^todo queue paused \S+: (.*)$/.exec(t)?.[1] }),
  ctx_window_suspect: (_key, t) => {
    const m = /^ctx (\d+)% is impossible: model (\S+), window/.exec(t);
    return clean({ pct: num(m?.[1]), model: m?.[2] });
  },
  skillify_repeat: (_key, t) => clean({ days: num(/came back on (\d+) days/.exec(t)?.[1]) }),
  history_off: (key, t) => clean({ service: key, reason: /^history search off \(\w+\): (\w+)$/.exec(t)?.[1] }),
  history_degraded: (key, t) => clean({ service: key, reason: /^history \w+ down \S+: (\w+)$/.exec(t)?.[1] }),
  backup_failed: (_key, t) => {
    const m = /^(?:snapshot backup|restore drill) of (.+) failed: (\S+)$/.exec(t);
    return clean({ path: m?.[1], code: m?.[2] });
  },
};

/** Facts that hold a code with its own catalogue section: the console and the English reason show the
 *  code's text (`<section>.<code>`) instead of the code. Per badge, fact name → catalogue section. */
export const CODED_FACTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  history_off: { reason: "history.reason" },
  history_degraded: { reason: "history.reason" },
};

/** The item's facts: the stored ones over the ones its key and title carry. Never throws. */
export function factsOf(row: Pick<AttentionRow, "kind" | "key" | "title" | "facts">): AttentionFacts {
  let derived: AttentionFacts | undefined;
  try {
    derived = DERIVE[row.kind]?.(row.key, row.title);
  } catch {
    derived = undefined;
  }
  return { ...(derived ?? {}), ...(row.facts ?? {}) };
}
