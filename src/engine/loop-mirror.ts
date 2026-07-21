// Compose scheduled-loop delivery across all operator surfaces. A scheduled loop's worker output
// goes to Telegram (via sendOperatorLine) or, before an admin is claimed, the daemon's stdout; this
// helper ALSO mirrors it to the web console through the operator bus so a web-only operator sees
// loop activity too. Pure/injectable so the fan-out is unit-testable without the daemon.
import type { OperatorBus } from "./operator-bus";

export function makeLoopReply(deps: {
  /** Deliver to the operator's Telegram DM (present only when a bot token + admin chat exist). */
  toTelegram?: (chatId: number, text: string, project?: string) => void;
  /** Fallback sink when there's no Telegram chat yet (the daemon logs to stdout). */
  toStdout: (text: string, project?: string) => void;
  /** Operator bus — the web sink receives the mirror. */
  bus?: OperatorBus;
}): (chatId: number, text: string, project?: string) => void {
  return (chatId, text, project) => {
    if (deps.toTelegram && chatId > 0) deps.toTelegram(chatId, text, project);
    else deps.toStdout(text, project);
    // Telegram (or stdout) already has the line — exclude the telegram origin so only the web sink
    // gets the mirror. No double-Telegram; the web console now shows loop output too.
    deps.bus?.mirror("telegram", { kind: "reply", text, project });
  };
}
