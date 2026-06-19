// Tracks the live worker sessions the engine is driving (in-process SDK handles).
// Unlike operant's session-registry (built for external processes reconnecting over a
// socket), these sessions are owned by the engine — no reconnect/ghost-slot logic.
import type { Order, SessionInfo } from "../types";

export interface Registry {
  add(order: Order, sdkSessionId: string): SessionInfo;
  get(id: string): SessionInfo | undefined;
  list(): SessionInfo[];
  remove(id: string): void;
}

export function createRegistry(): Registry {
  const sessions = new Map<string, SessionInfo>();
  return {
    add(_order: Order, _sdkSessionId: string): SessionInfo {
      throw new Error("not implemented (Phase 1)");
    },
    get(id: string): SessionInfo | undefined {
      return sessions.get(id);
    },
    list(): SessionInfo[] {
      return [...sessions.values()];
    },
    remove(id: string): void {
      sessions.delete(id);
    },
  };
}
