// The on-screen keyboard on a phone (ADR-0071). Android resizes the layout to the visual viewport
// (interactive-widget=resizes-content), so nothing is covered. iOS keeps the layout and only shrinks the
// visual viewport, so a bottom sheet would sit behind the keyboard. Pure, unit-tested.

/** The height (px) of the layout viewport that the keyboard covers below the visual viewport; 0 when none. */
export function keyboardInset(layoutHeight: number, vv: { height: number; offsetTop: number }): number {
  return Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop));
}
