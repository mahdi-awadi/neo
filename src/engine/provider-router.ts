// THE COMPLIANCE FIREWALL. Maps an order to the provider allowed to run it.
//   source "neo"      -> the configured own-work provider (default: subscription, via the SDK)
//   source "customer" -> NEVER the subscription. MVP refuses (Gemini path is Phase 3).
// The customer->subscription block is a HARD rule here, independent of config, so a
// misconfigured `customerWork` can never leak customer work onto the subscription.
import type { NeoConfig } from "../config";
import type { Order, RouteResult } from "../types";

export function route(order: Order, cfg: NeoConfig): RouteResult {
  if (order.source === "customer") {
    // Hard firewall: customers never touch the Claude subscription, regardless of config.
    // The Gemini worker path is not built yet (Phase 3), so refuse with a clear reason.
    return {
      refuse:
        "customer-direct work cannot use the Claude subscription; the Gemini path is not built yet (Phase 3)",
    };
  }
  // Neo's own work -> configured provider (default subscription).
  return { provider: cfg.providers.ownWork };
}
