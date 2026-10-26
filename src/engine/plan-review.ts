// The question a plan card's review decision carries (ADR-0036), written and read in one place. The
// ledger reads an older card's plan path back from it (ADR-0053): decisions have no plan column.

/** Prefixes the engine has written, newest first ("Plan ready for review:" before ADR-0036). */
const PREFIXES = ["Plan waiting for your approval: ", "Plan ready for review: "] as const;
const SEPARATOR = " — ";

/** The question of a plan card's review decision. */
export function reviewQuestion(path: string, title: string): string {
  return `${PREFIXES[0]}${path}${SEPARATOR}${title}`;
}

/** The plan path a review question names, else undefined (not a plan card's question). */
export function reviewedPath(question: string): string | undefined {
  const prefix = PREFIXES.find((p) => question.startsWith(p));
  if (!prefix) return undefined;
  const rest = question.slice(prefix.length);
  const end = rest.indexOf(SEPARATOR);
  const path = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return path || undefined;
}
