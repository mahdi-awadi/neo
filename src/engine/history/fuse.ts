// The task history's fusion of its search lists (ADR-0067 Decision 6, spec "Search" step 6): weighted
// reciprocal rank fusion by ref. Each list is ranked best first and may hold several chunks of one ref; the
// first (best) one gives the ref its rank. `score = Σ weight / (k + rank)`; an exact hit adds `exactBoost`
// on top, so exact hits come first. Ties go to the newer hit. Refs whose best chunks have the same text
// collapse into the best one, which names the others in `alsoIn`. Pure.

export type ListName = "exact" | "meaning" | "words" | "lines";

/** One entry of a ranked list. `chunkId` and `textHash` are the chunk that matched (absent for a source
 *  found by its id alone, or a worker line). */
export interface Ranked {
  ref: string;
  at: number;
  chunkId?: number;
  textHash?: string;
}

export interface FuseOpts {
  k: number;
  weights: { meaning: number; words: number; lines: number };
  exactBoost: number;
  limit: number;
}

export interface Fused {
  ref: string;
  score: number;
  at: number;
  /** The lists the ref is in, in list order. */
  via: ListName[];
  /** The chunk of the ref's largest contribution that names one (for the snippet). */
  chunkId?: number;
  textHash?: string;
  alsoIn?: string[];
}

const ORDER: ListName[] = ["exact", "meaning", "words", "lines"];

export function fuse(lists: Partial<Record<ListName, Ranked[]>>, opts: FuseOpts): Fused[] {
  const acc = new Map<string, Fused & { best: number }>();
  for (const name of ORDER) {
    const list = lists[name] ?? [];
    const weight = name === "exact" ? 1 : opts.weights[name];
    let rank = 0;
    const seen = new Set<string>();
    for (const r of list) {
      if (seen.has(r.ref)) continue;
      seen.add(r.ref);
      rank++;
      const part = weight / (opts.k + rank);
      const cur = acc.get(r.ref) ?? { ref: r.ref, score: 0, at: r.at, via: [], best: -1 };
      cur.score += part + (name === "exact" ? opts.exactBoost : 0);
      cur.at = Math.max(cur.at, r.at);
      cur.via.push(name);
      if (r.chunkId !== undefined && part > cur.best) {
        cur.best = part;
        cur.chunkId = r.chunkId;
        if (r.textHash !== undefined) cur.textHash = r.textHash;
        else delete cur.textHash;
      }
      acc.set(r.ref, cur);
    }
  }
  const sorted = [...acc.values()].sort((a, b) => b.score - a.score || b.at - a.at || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const out: Fused[] = [];
  const byText = new Map<string, Fused>();
  for (const { best: _best, ...h } of sorted) {
    const first = h.textHash !== undefined ? byText.get(h.textHash) : undefined;
    if (first) {
      first.alsoIn = [...(first.alsoIn ?? []), h.ref];
      continue;
    }
    if (h.textHash !== undefined) byText.set(h.textHash, h);
    out.push(h);
  }
  return out.slice(0, Math.max(0, opts.limit));
}
