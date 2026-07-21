// The operator-channel broadcast bus. There is ONE operator (the admin) on two surfaces —
// Telegram and the web console. Each live frontend registers a SINK; the engine mirrors a line
// to every OTHER sink so both surfaces show one conversation. No AI, deterministic, no I/O.
//
// No-feedback-loop invariant (critical): a sink is OUTPUT-ONLY — `deliver` renders on its surface
// and returns; it never re-enters the pipeline and never calls `mirror`. The bus does not listen to
// its own output. So a mirrored line can never become an order or re-broadcast — structurally, not
// by convention. `mirror(originId, …)` excludes the origin (which already displayed the line
// locally): that exclusion is both the loop guard and the de-dupe.

/** One line to display across surfaces. `reply` = Neo output / worker progress; `echo` = the
 *  operator's own inbound message arriving from another surface; `notice` = display-only chrome
 *  (e.g. "approval pending on the other surface"). */
export type BusLine =
  | { kind: "reply"; text: string; project?: string }
  | { kind: "echo"; text: string }
  | { kind: "notice"; text: string };

/** A connected operator surface. `id` is the origin tag ("telegram" | "web"); `deliver` renders the
 *  line on that surface and MUST NOT re-enter the pipeline. */
export interface OperatorSink {
  id: string;
  deliver(line: BusLine): void;
}

export interface OperatorBus {
  /** Register a sink (one per id — a re-register replaces). Returns an unregister fn. */
  register(sink: OperatorSink): () => void;
  /** Fan `line` out to every registered sink whose id !== originId. Never throws. */
  mirror(originId: string, line: BusLine): void;
}

export function createOperatorBus(): OperatorBus {
  // Keyed by sink id so one surface holds at most one sink (a reconnecting web frontend replaces
  // its old sink rather than stacking duplicates).
  const sinks = new Map<string, OperatorSink>();

  return {
    register(sink) {
      sinks.set(sink.id, sink);
      return () => {
        // Only remove if it is still THIS sink (a later re-register may have replaced it).
        if (sinks.get(sink.id) === sink) sinks.delete(sink.id);
      };
    },
    mirror(originId, line) {
      for (const sink of sinks.values()) {
        if (sink.id === originId) continue; // origin already displayed it locally
        try {
          sink.deliver(line);
        } catch {
          // a dead/throwing surface (e.g. no web listener) must never block the others
        }
      }
    },
  };
}
