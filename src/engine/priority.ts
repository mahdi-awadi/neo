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

/** A short leading marker for the line (rendering only). `progress` is the silent default and
 *  carries no badge, so ordinary streamed worker output reads exactly as it does today. */
export function priorityBadge(p: Priority): string {
  switch (p) {
    case "decision":
      return "🔷 DECISION";
    case "alert":
      return "⛔ ALERT";
    case "done":
      return "✅ DONE";
    default:
      return "";
  }
}
