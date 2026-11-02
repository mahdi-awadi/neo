// The Core splash (ADR-0056 amendment): it covers the console from the first paint and fades out once
// the app is ready — but not before its short intro has played. Pure, so it is unit-tested.

/** How long to keep the splash after the app is ready: the rest of the intro, or nothing. */
export function splashHideIn(o: { shownAt: number; now: number; animMs: number; reduced: boolean }): number {
  if (o.reduced || !Number.isFinite(o.animMs)) return 0;
  return Math.max(0, o.animMs - (o.now - o.shownAt));
}

/** Fade the splash out and remove it, once the app is ready (`ready` settled). The timing comes from
 *  the CSS token `--splash-ms`, the one source the animation also uses. */
export function dismissSplash(ready: Promise<unknown>): void {
  const el = document.getElementById("splash");
  if (!el) return;
  const animMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--splash-ms"));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  void ready.finally(() => {
    setTimeout(() => {
      el.classList.add("out");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 600); // no transition (reduced motion): remove anyway
    }, splashHideIn({ shownAt: 0, now: performance.now(), animMs, reduced }));
  });
}
