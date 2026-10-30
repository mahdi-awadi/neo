// The task history's query parsing and exact-id lookups (ADR-0067, spec "Search" step 1 and 2): the id
// tokens of a query (`extract.ts` finds them), its search terms (normalized words outside the ids, without
// stop words), whether it is only ids (then no embed call is made), and for each id token how `history.db`
// finds its sources — direct refs, a ref prefix, a meta field, or an FTS phrase or prefix query on `body`.
// Pure.
import { findIdTokens, type IdToken } from "./extract";
import { normalize } from "./normalize";
import stopwords from "./stopwords.json";

/** The Arabic and English stop words, normalized like the text they are compared with. */
export const STOP_WORDS: ReadonlySet<string> = new Set([...stopwords.en, ...stopwords.ar].map((w) => normalize(w)));

const WORD = /[\p{L}\p{N}]+/gu;

export interface ParsedQuery {
  tokens: IdToken[];
  /** Normalized words outside the id tokens, without stop words, in query order, each once. */
  terms: string[];
  /** The query has ids and no other search word. */
  idOnly: boolean;
}

export function parseQuery(query: string, stop: ReadonlySet<string> = STOP_WORDS): ParsedQuery {
  const tokens = findIdTokens(query);
  let rest = query;
  for (const t of [...tokens].reverse()) rest = `${rest.slice(0, t.start)} ${rest.slice(t.end)}`;
  const terms = [...new Set(Array.from(normalize(rest).matchAll(WORD), (m) => m[0]).filter((w) => !stop.has(w)))];
  return { tokens, terms, idOnly: tokens.length > 0 && terms.length === 0 };
}

/** How `history.db` finds the sources one id names. */
export interface ExactLookup {
  /** Refs the id names directly. */
  refs: string[];
  /** Refs that start with this (a decision id prefix). */
  prefix?: string;
  /** Sources whose meta names this todo, order or thread. */
  meta?: { field: "todo" | "order" | "thread"; value: string | number };
  /** An FTS5 query on `body`: a sha prefix, or a PNR-like code as a phrase. */
  fts?: string;
}

export function exactLookup(t: IdToken): ExactLookup {
  switch (t.kind) {
    case "ref":
      return { refs: [t.value] };
    case "order":
      return { refs: [`order:${t.value}`, `result:${t.value}`], meta: { field: "order", value: t.value } };
    case "decision":
      return { refs: [], prefix: `dec:${t.value}` };
    case "todo":
      return { refs: [`todo:${t.value}`], meta: { field: "todo", value: Number(t.value) } };
    case "plan":
      return { refs: [`plan:${t.value}`] };
    case "note":
      return { refs: [`note:${t.value}`] };
    case "thread": {
      const id = parseInt(t.value.slice(1), 36);
      return { refs: [`msg:${id}`], meta: { field: "thread", value: id } };
    }
    case "sha":
      // Hex only (the token rule), so the quotes need no escaping.
      return { refs: [], fts: `"${t.value}"*` };
    case "pnr":
      return { refs: [], fts: `"${normalize(t.value)}"` };
  }
}
