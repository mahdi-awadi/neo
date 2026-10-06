// Narrow master–detail and the browser history (spec 2026-10-07, AC4). On a phone, opening a thread
// or a project is one history entry `{ detail: <view id> }`, so the browser back returns to the list.
// Pure rules, unit-tested: the screen (the `detail` classes) and the history never fall out of step.

export type DetailView = "vthreads" | "vprojects";
const VIEWS: readonly string[] = ["vthreads", "vprojects"];

/** The detail view a history state names, or null. */
function detailOf(state: unknown): DetailView | null {
  const d = (state as { detail?: unknown } | null)?.detail;
  return typeof d === "string" && VIEWS.includes(d) ? (d as DetailView) : null;
}

/** Entering `view`'s detail: push a new entry from a list, replace when the entry is already a detail
 *  (another view's — no stacking), nothing when it is this view's or the screen is wide. */
export function enterAction(state: unknown, view: DetailView, narrow: boolean): "push" | "replace" | "none" {
  if (!narrow) return "none";
  const d = detailOf(state);
  return d === null ? "push" : d === view ? "none" : "replace";
}

/** After popstate every view leaves detail; only the view on screen re-enters it, if the state names it. */
export function popDetail(state: unknown, current: DetailView | null): DetailView | null {
  const d = detailOf(state);
  return d !== null && d === current ? d : null;
}

/** The in-app back: through the history when its entry is this view's detail, else just leave detail. */
export function backAction(state: unknown, current: DetailView | null): "history" | "local" {
  return current !== null && detailOf(state) === current ? "history" : "local";
}

/** A detail entry that survived a reload has no detail on screen any more: it must be cleared. */
export function staleOnLoad(state: unknown): boolean {
  return detailOf(state) !== null;
}
