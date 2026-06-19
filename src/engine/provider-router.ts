// THE COMPLIANCE FIREWALL. Maps an order to the provider allowed to run it.
//   source "neo"      -> subscription (your own work, via the Claude Agent SDK)
//   source "customer" -> gemini       (a customer never touches the subscription)
// Reads config so a future Anthropic plan change is a config flip, not a rewrite.
// Phase 1 (TDD): MUST refuse, in code, any attempt to route customer work to the
// subscription — assert that branch explicitly.
import type { NeoConfig } from "../config";
import type { Order, RouteResult } from "../types";

export function route(_order: Order, _cfg: NeoConfig): RouteResult {
  throw new Error("not implemented (Phase 1)");
}
