// How a brief (or any first line of text) is named in lines and lists. A leaf module so both the
// todo queue and the ledger migrations (legacy thread titles) use the one rule.

/** Max chars of a brief's title in operator lines and lists. */
const TITLE_MAX = 60;

/** The first non-empty line of a brief, bounded — how a todo is named in lines and lists. */
export function todoTitle(brief: string): string {
  const first = brief.split("\n").find((l) => l.trim())?.trim() ?? "";
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}
