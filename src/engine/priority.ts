// Deterministic message-priority model. Pure, AI-free: it only maps a sender's INTENT (expressed
// through the call site it flows from — never inferred from prose) to a delivery surface + a display
// badge. DECISION/ALERT need the operator's attention, so they go to the notified "Decisions"
// channel; PROGRESS/DONE are the muted firehose. The default everywhere is `progress`, so any
// un-tagged line keeps today's behavior (it lands in the firehose).
export type Priority = "decision" | "alert" | "progress" | "done";

/** Which surface a priority goes to. decision+alert → the high-priority Decisions channel;
 *  progress+done → the muted firehose. Pure, total over Priority. */
export function surfaceFor(p: Priority): "decisions" | "firehose" {
  return p === "decision" || p === "alert" ? "decisions" : "firehose";
}

/** The visual style for a priority. Telegram has no text colors, so "color" = a consistent accent
 *  emoji + a short label. This is the ONE data-driven source every surface renders from, so styling
 *  is configurable here (not hardcoded per call site). One accent per line — tasteful, not a firehose
 *  of emoji. `progress` is the silent default: no accent, so ordinary streamed worker output reads
 *  exactly as it does today. */
export interface PriorityStyle {
  /** The single leading accent emoji (empty for the silent `progress` default). */
  accent: string;
  /** Short uppercase word for a full badge (empty for `progress`). */
  label: string;
}

/** Central, data-driven priority → style map. decision 🔵, alert 🔴, done 🟢; progress is silent. */
export const PRIORITY_STYLES: Record<Priority, PriorityStyle> = {
  decision: { accent: "🔵", label: "DECISION" },
  alert: { accent: "🔴", label: "ALERT" },
  done: { accent: "🟢", label: "DONE" },
  progress: { accent: "", label: "" },
};

/** The style for a priority (total over Priority). */
export function priorityStyle(p: Priority): PriorityStyle {
  return PRIORITY_STYLES[p];
}

/** The line's accent as a prefix WITH a trailing space, ready to compose in front of the `#project`
 *  tag and body (e.g. "🟢 "). Empty for progress / undefined, so streamed output is untouched. */
export function accentPrefix(p?: Priority): string {
  const accent = PRIORITY_STYLES[p ?? "progress"].accent;
  return accent ? `${accent} ` : "";
}

/** Prepend the priority's single accent to a line. Idempotent for `progress`/undefined (returns the
 *  text unchanged) and non-stacking: styling an already-accented line does not add a second accent. */
export function styleLine(text: string, p?: Priority): string {
  const accent = PRIORITY_STYLES[p ?? "progress"].accent;
  if (!accent || text.startsWith(accent)) return text;
  return `${accent} ${text}`;
}

/** A short leading marker for the line (rendering only), derived from the central style map.
 *  `progress` carries no badge, so ordinary streamed worker output reads exactly as it does today. */
export function priorityBadge(p: Priority): string {
  const { accent, label } = PRIORITY_STYLES[p];
  return accent ? `${accent} ${label}` : "";
}
