// Two-tap confirmation for a destructive one-tap control (the project kill button), on every pointer: the first tap arms
// it, a second tap inside CONFIRM_WINDOW_MS fires. Pure, so it is unit-tested.

/** How long an armed control waits for its second tap. */
export const CONFIRM_WINDOW_MS = 4000;

/** What a tap does, given when the control was armed (undefined: not armed). */
export function confirmTap(armedAt: number | undefined, now: number): "arm" | "fire" {
  return armedAt !== undefined && now - armedAt <= CONFIRM_WINDOW_MS ? "fire" : "arm";
}

/** The live arm of control `id`, kept across re-renders in `arms`; an expired arm is dropped. */
export function armedFor<K>(arms: Map<K, number>, id: K, now: number): number | undefined {
  const at = arms.get(id);
  if (at === undefined) return undefined;
  if (now - at > CONFIRM_WINDOW_MS) {
    arms.delete(id);
    return undefined;
  }
  return at;
}
