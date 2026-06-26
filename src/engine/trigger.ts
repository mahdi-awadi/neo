// Trigger model + a tiny, dependency-free 5-field cron matcher. AI-free and deterministic — the
// scheduler asks isDue() each tick. Supports `*`, `n`, `*/n`, `a-b`, `a,b`; day-of-week 0 or 7 = Sun.
// No L/W/?/name-aliases (YAGNI). Local timezone, matching Claude Code's cron semantics.

export type Trigger =
  | { kind: "manual" }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expr: string };

function fieldMatches(spec: string, value: number, min: number, max: number): boolean {
  return spec.split(",").some((part) => {
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      step = Number(part.slice(slash + 1));
      range = part.slice(0, slash);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step < 1) return false;
    for (let v = lo; v <= hi; v += step) if (v === value) return true;
    return false;
  });
}

export function cronMatches(expr: string, at: number): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  const d = new Date(at);
  const day = d.getDay(); // 0=Sun..6=Sat

  const domMatch = fieldMatches(dom, d.getDate(), 1, 31);
  const dowMatch = fieldMatches(dow, day, 0, 7) || (day === 0 && fieldMatches(dow, 7, 0, 7));
  // vixie-cron: when BOTH dom and dow are restricted, a date matches if EITHER matches.
  const dayOk = dom !== "*" && dow !== "*" ? domMatch || dowMatch : domMatch && dowMatch;

  return (
    fieldMatches(min, d.getMinutes(), 0, 59) &&
    fieldMatches(hour, d.getHours(), 0, 23) &&
    fieldMatches(mon, d.getMonth() + 1, 1, 12) &&
    dayOk
  );
}

/** Is this trigger due to fire now, given when it last ran? Manual never fires via the scheduler. */
export function isDue(trigger: Trigger, lastRun: number | undefined, now: number): boolean {
  switch (trigger.kind) {
    case "manual":
      return false;
    case "interval":
      return now - (lastRun ?? 0) >= trigger.everyMs;
    case "cron":
      return cronMatches(trigger.expr, now) && (lastRun === undefined || now - lastRun >= 60_000);
  }
}
