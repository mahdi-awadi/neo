// Maps a sent channel message back to the PROJECT that produced it, so that when the operator
// *replies* to a specific worker message (Telegram's reply gesture), the engine can route the
// follow-up into THAT project's session — even when another project is the active one in the feed.
//
// Backed by the ledger (bun:sqlite) so a mapping survives /reload and daemon restart; the in-memory
// Map is a fast cache in FRONT of it. The ledger is the source of truth — a cache miss (eviction or
// a fresh process after reload) falls through to the ledger instead of silently losing the route
// (which is what mis-sent a project reply to the company).
import type { RouteTarget } from "../types";

/** The ledger subset MessageRoutes persists through (openLedger satisfies it). */
export interface RouteLedger {
  rememberRoute(chatId: number, messageId: number, target: RouteTarget): void;
  routeFor(chatId: number, messageId: number): RouteTarget | undefined;
}

export interface MessageRoutes {
  /** Remember that channel message (`chatId`,`messageId`) was produced by `target`'s project. */
  remember(chatId: number, messageId: number, target: RouteTarget): void;
  /** The project a replied-to message belongs to (cache → ledger), or undefined if untracked. */
  lookup(chatId: number, messageId: number): RouteTarget | undefined;
}

/** `cacheCap` bounds the in-memory cache (oldest evicted first); the `ledger`, when given, is the
 *  durable source of truth behind it. Without a ledger it degrades to a pure in-memory cache. */
export function createMessageRoutes(opts: { ledger?: RouteLedger; cacheCap?: number } = {}): MessageRoutes {
  const cap = opts.cacheCap ?? 2000;
  // Map preserves insertion order, so the first key is always the oldest — cheap LRU-by-age.
  const cache = new Map<string, RouteTarget>();
  const key = (chatId: number, messageId: number) => `${chatId}:${messageId}`;

  return {
    remember(chatId, messageId, target) {
      cache.set(key(chatId, messageId), target);
      while (cache.size > cap) cache.delete(cache.keys().next().value as string);
      opts.ledger?.rememberRoute(chatId, messageId, target);
    },
    lookup(chatId, messageId) {
      const hit = cache.get(key(chatId, messageId));
      if (hit) return hit;
      const persisted = opts.ledger?.routeFor(chatId, messageId);
      if (persisted) cache.set(key(chatId, messageId), persisted); // warm the cache for next time
      return persisted;
    },
  };
}
