// Maps a sent channel message back to the session that produced it, so that when the operator
// *replies* to a specific worker message (Telegram's reply gesture), the engine can route the
// follow-up into THAT project's session — even when another project is the active one in the feed.
// Channel-agnostic (keyed by an opaque numeric message id); bounded so it can't grow forever.

export interface MessageRoutes {
  /** Remember that channel message `messageId` was produced by session `sessionId`. */
  remember(messageId: number, sessionId: string): void;
  /** The session a replied-to message belongs to, or undefined if it isn't tracked (any more). */
  sessionFor(messageId: number): string | undefined;
}

/** `cap` bounds how many recent message→session links are kept (oldest evicted first). */
export function createMessageRoutes(cap = 2000): MessageRoutes {
  // Map preserves insertion order, so the first key is always the oldest — cheap LRU-by-age.
  const map = new Map<number, string>();
  return {
    remember(messageId, sessionId) {
      map.set(messageId, sessionId);
      while (map.size > cap) map.delete(map.keys().next().value as number);
    },
    sessionFor(messageId) {
      return map.get(messageId);
    },
  };
}
