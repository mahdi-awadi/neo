// Two-tap confirmation for a destructive one-tap control (the project kill button): the first tap arms
// it, a second tap inside CONFIRM_WINDOW_MS fires. Pure, so it is unit-tested.

/** How long an armed control waits for its second tap. */
export const CONFIRM_WINDOW_MS = 4000;

/** What a tap does, given when the control was armed (undefined: not armed). */
export function confirmTap(armedAt: number | undefined, now: number): "arm" | "fire" {
  return armedAt !== undefined && now - armedAt <= CONFIRM_WINDOW_MS ? "fire" : "arm";
}
