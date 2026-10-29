// Config `projectMessage` (ADR-0061), a leaf module so config.ts can read it without importing the tool.

export interface ProjectMessageCfg {
  /** Longer is new work: `dispatch`. */
  maxChars: number;
  /** Delivered messages per project in the last hour. */
  perProjectPerHour: number;
}

export const DEFAULT_PROJECT_MESSAGE_CFG: ProjectMessageCfg = { maxChars: 500, perProjectPerHour: 6 };

/** Config `projectMessage`: each positive whole number is kept, anything else is the default. */
export function readProjectMessageCfg(raw: unknown): ProjectMessageCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : d);
  return { maxChars: pos(r.maxChars, DEFAULT_PROJECT_MESSAGE_CFG.maxChars), perProjectPerHour: pos(r.perProjectPerHour, DEFAULT_PROJECT_MESSAGE_CFG.perProjectPerHour) };
}
