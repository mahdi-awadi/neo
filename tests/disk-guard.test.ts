// ADR-0068: the disk guard runs in the daemon's heartbeat, deterministic and with no AI session. It runs
// Tier A at once under disk pressure and at the daily hour, and alerts the operator before the disk is
// full — so disk safety never waits for a free loop session (the 2026-10-30 full disk: the cleanup loop's
// folder, /home/neo, was always busy and the scheduler skipped it for 19 hours).
import { describe, expect, test } from "bun:test";
import { decideDisk, fillRateBytesPerHour, runDiskGuard, type DiskGuardCfg, type DiskGuardState } from "../src/engine/disk-guard";

const GB = 1e9;
const H = 3_600_000;
const SIZE = 400 * GB;
const cfg: DiskGuardCfg = {
  mount: "/",
  alertStepsPct: [80, 90, 95],
  alertRepeatMinutes: 120,
  pressureFreePct: 10,
  pressureCooldownMinutes: 30,
  dailyHour: 4,
  sampleKeepHours: 6,
  nothingLeftBytes: 1e9,
  cooldownHours: 6,
  alertHysteresisPct: 2,
  pendingTimeoutMinutes: 120,
};
/** A server-local time on 2026-10-30 at `h:m`. */
const at = (h: number, m = 0) => new Date(2026, 9, 30, h, m).getTime();
const use = (pct: number) => ({ size: SIZE, used: (SIZE * pct) / 100 });
const fresh = (): DiskGuardState => ({ samples: [] });

describe("decideDisk (pure)", () => {
  test("below every threshold, outside the daily hour: nothing to do, only a sample is kept", () => {
    const d = decideDisk({ now: at(10), usage: use(70), state: fresh(), runActive: false }, cfg);
    expect(d.run).toBeUndefined();
    expect(d.alert).toBeUndefined();
    expect(d.state.samples).toHaveLength(1);
  });

  test("crossing a step alerts once; the same step is quiet until the repeat time; a higher step alerts at once", () => {
    let s = fresh();
    const a = decideDisk({ now: at(10), usage: use(81), state: s, runActive: false }, cfg);
    expect(a.alert?.stepPct).toBe(80);
    s = a.state;
    expect(decideDisk({ now: at(10, 30), usage: use(82), state: s, runActive: false }, cfg).alert).toBeUndefined();
    expect(decideDisk({ now: at(12, 1), usage: use(82), state: s, runActive: false }, cfg).alert).toBeUndefined(); // flat: no repeat
    expect(decideDisk({ now: at(12, 1), usage: use(83), state: s, runActive: false }, cfg).alert?.stepPct).toBe(80); // still rising after 120 min
    const b = decideDisk({ now: at(10, 31), usage: use(91), state: s, runActive: false }, cfg);
    expect(b.alert?.stepPct).toBe(90);
  });

  test("hysteresis: hovering just under the step keeps the alert; falling below step − hysteresis clears it", () => {
    let h = decideDisk({ now: at(10), usage: use(80.1), state: fresh(), runActive: false }, cfg).state;
    h = decideDisk({ now: at(10, 1), usage: use(79.9), state: h, runActive: false }, cfg).state;
    expect(h.alert).toBeDefined();
    expect(decideDisk({ now: at(10, 2), usage: use(80.1), state: h, runActive: false }, cfg).alert).toBeUndefined();
  });

  test("falling back below the first step clears the alert, so the next crossing alerts again", () => {
    let s = decideDisk({ now: at(10), usage: use(85), state: fresh(), runActive: false }, cfg).state;
    s = decideDisk({ now: at(10, 5), usage: use(60), state: s, runActive: false }, cfg).state;
    expect(s.alert).toBeUndefined();
    expect(decideDisk({ now: at(10, 10), usage: use(81), state: s, runActive: false }, cfg).alert?.stepPct).toBe(80);
  });

  test("less free space than pressureFreePct runs Tier A at once; not again inside the cooldown; never while a run holds the lock", () => {
    const first = decideDisk({ now: at(10), usage: use(91), state: fresh(), runActive: false }, cfg);
    expect(first.run).toBe("pressure");
    expect(decideDisk({ now: at(10, 20), usage: use(91), state: first.state, runActive: false }, cfg).run).toBeUndefined();
    expect(decideDisk({ now: at(10, 31), usage: use(91), state: first.state, runActive: false }, cfg).run).toBe("pressure");
    expect(decideDisk({ now: at(10), usage: use(95), state: fresh(), runActive: true }, cfg).run).toBeUndefined();
  });

  test("back-off: a recent run that freed less than nothingLeftBytes stops pressure runs for cooldownHours", () => {
    const lastRun = { at: at(9), freedBytes: 0.2e9 };
    expect(decideDisk({ now: at(10), usage: use(92), state: fresh(), runActive: false, lastRun }, cfg).run).toBeUndefined();
    expect(decideDisk({ now: at(15, 1), usage: use(92), state: fresh(), runActive: false, lastRun }, cfg).run).toBe("pressure");
    expect(decideDisk({ now: at(10), usage: use(92), state: fresh(), runActive: false, lastRun: { at: at(9, 50), freedBytes: 40e9 } }, cfg).run).toBeUndefined(); // a real run 10 min ago: cooldown
  });

  test("the kit's own last run (the loop, by hand) counts: no daily run after one today, no pressure run inside the cooldown", () => {
    expect(decideDisk({ now: at(4, 5), usage: use(40), state: fresh(), runActive: false, lastRun: { at: at(3, 58), freedBytes: 5e9 } }, cfg).run).toBeUndefined();
    expect(decideDisk({ now: at(4, 5), usage: use(40), state: fresh(), runActive: false, lastRun: { at: at(4, 1), freedBytes: 5e9 } }, cfg).run).toBeUndefined();
  });

  test("a daily run missed while the daemon was down catches up later the same day, once", () => {
    const d = decideDisk({ now: at(9), usage: use(40), state: fresh(), runActive: false, lastRun: { at: at(4) - 86_400_000, freedBytes: 5e9 } }, cfg);
    expect(d.run).toBe("daily");
    expect(decideDisk({ now: at(9, 30), usage: use(40), state: d.state, runActive: false }, cfg).run).toBeUndefined();
    expect(decideDisk({ now: at(3), usage: use(40), state: fresh(), runActive: false, lastRun: { at: at(4) - 86_400_000, freedBytes: 5e9 } }, cfg).run).toBeUndefined(); // before today's hour
  });

  test("the daily run starts in the daily hour once a day, whatever the use, and never twice the same day", () => {
    const d = decideDisk({ now: at(4, 5), usage: use(40), state: fresh(), runActive: false }, cfg);
    expect(d.run).toBe("daily");
    expect(decideDisk({ now: at(4, 40), usage: use(40), state: d.state, runActive: false }, cfg).run).toBeUndefined();
    expect(decideDisk({ now: at(5, 0), usage: use(40), state: fresh(), runActive: false, lastRun: { at: at(4, 10), freedBytes: 1e9 } }, cfg).run).toBeUndefined();
  });

  test("the alert names the use, the free space and, from the recent samples, the hours until full", () => {
    let s = fresh();
    for (let i = 0; i <= 4; i++) s = decideDisk({ now: at(5 + i), usage: { size: SIZE, used: 300 * GB + i * 3.3 * GB }, state: s, runActive: false }, cfg).state;
    const d = decideDisk({ now: at(10), usage: { size: SIZE, used: 322 * GB }, state: s, runActive: false }, cfg);
    expect(d.alert?.stepPct).toBe(80);
    expect(d.alert?.text).toContain("80.5%");
    expect(d.alert?.text).toContain("78 GB free");
    expect(d.alert?.text).toMatch(/full in about 1\d h/); // ~4 GB/h → ~19–20 h
  });

  test("samples older than sampleKeepHours are dropped", () => {
    let s = fresh();
    for (let i = 0; i < 10; i++) s = decideDisk({ now: at(0) + i * H, usage: use(50), state: s, runActive: false }, cfg).state;
    expect(s.samples.every((x) => x.at >= at(0) + 9 * H - 6 * H)).toBe(true);
  });
});

describe("fillRateBytesPerHour", () => {
  test("a cleanup drop is not a negative fill: only the samples since the last drop count", () => {
    const s = [{ at: 0, used: 300 * GB }, { at: H, used: 304 * GB }, { at: 2 * H, used: 210 * GB }, { at: 3 * H, used: 214 * GB }, { at: 4 * H, used: 218 * GB }];
    expect(fillRateBytesPerHour(s)).toBeCloseTo(4 * GB, -6);
  });

  test("a least-squares slope over the samples; under two samples or a flat or shrinking disk gives 0", () => {
    expect(fillRateBytesPerHour([])).toBe(0);
    expect(fillRateBytesPerHour([{ at: 0, used: 1 }])).toBe(0);
    expect(fillRateBytesPerHour([{ at: 0, used: 10 * GB }, { at: H, used: 13 * GB }, { at: 2 * H, used: 16 * GB }])).toBeCloseTo(3 * GB, -6);
    expect(fillRateBytesPerHour([{ at: 0, used: 20 * GB }, { at: H, used: 10 * GB }])).toBe(0);
  });
});

describe("runDiskGuard (effects through injected deps)", () => {
  function deps(over: { pct?: number; runActive?: boolean; spawnThrows?: boolean } = {}) {
    const calls = { spawned: [] as string[][], alerts: [] as string[], events: [] as Array<[string, Record<string, unknown>]> };
    let state: DiskGuardState | undefined;
    return {
      calls,
      get state() {
        return state;
      },
      d: {
        cfg,
        usage: () => use(over.pct ?? 50),
        runActive: () => over.runActive ?? false,
        loadState: () => state,
        saveState: (s: DiskGuardState) => void (state = s),
        spawnRun: (argv: string[]) => {
          if (over.spawnThrows) throw new Error("spawn failed");
          calls.spawned.push(argv);
        },
        runArgv: ["bun", "/kit/cleanup.ts", "run"],
        alert: (t: string) => void calls.alerts.push(t),
        event: (k: string, data: Record<string, unknown>) => void calls.events.push([k, data]),
        now: () => at(10),
      },
    };
  }

  test("pressure: spawns the kit's Tier A run (argv, no shell), alerts and records the event", () => {
    const x = deps({ pct: 92 });
    runDiskGuard(x.d);
    expect(x.calls.spawned).toEqual([["bun", "/kit/cleanup.ts", "run"]]);
    expect(x.calls.alerts).toHaveLength(1);
    expect(x.calls.events.map(([k]) => k)).toEqual(["disk_alert", "disk_cleanup_started"]);
    expect(x.state?.lastPressureRun).toBe(at(10));
  });

  test("a failed spawn or a broken usage read never throws out of the heartbeat", () => {
    const x = deps({ pct: 92, spawnThrows: true });
    expect(() => runDiskGuard(x.d)).not.toThrow();
    expect(x.calls.events.map(([k]) => k)).toContain("disk_cleanup_failed");
    const y = deps();
    expect(() => runDiskGuard({ ...y.d, usage: () => { throw new Error("df failed"); } })).not.toThrow();
  });

  test("when the started run has finished, its result is reported once (what it freed, the use after)", () => {
    const x = deps({ pct: 92 });
    runDiskGuard(x.d);
    const done = { at: at(10) + 60_000, freedBytes: 42 * GB, afterPct: 61.2 };
    runDiskGuard({ ...x.d, usage: () => use(61), now: () => at(10, 5), lastRun: () => done });
    expect(x.calls.alerts.at(-1)).toContain("42.0 GB");
    expect(x.calls.alerts.at(-1)).toContain("61.2%");
    const n = x.calls.alerts.length;
    runDiskGuard({ ...x.d, usage: () => use(61), now: () => at(10, 6), lastRun: () => done });
    expect(x.calls.alerts.length).toBe(n);
  });

  test("a run that holds the kit lock is never doubled", () => {
    const x = deps({ pct: 95, runActive: true });
    runDiskGuard(x.d);
    expect(x.calls.spawned).toEqual([]);
  });
});

describe("guardCfgFrom (the kit's config is the one source)", () => {
  test("reads the guard keys from the kit's config; the fallback for an older installed kit equals defaults.json", async () => {
    const { guardCfgFrom, DISK_GUARD_FALLBACK } = await import("../src/engine/disk-guard");
    const defaults = (await import("../tools/disk/defaults.json")).default as Record<string, unknown>;
    for (const [k, v] of Object.entries(DISK_GUARD_FALLBACK)) expect(defaults[k]).toEqual(v);
    const { KIT_BACKOFF_FALLBACK } = await import("../src/engine/disk-guard");
    for (const [k, v] of Object.entries(KIT_BACKOFF_FALLBACK)) expect(defaults[k]).toEqual(v);
    const full = guardCfgFrom({ ...defaults, mount: "/data", pressureFreePct: 15 } as never);
    expect(full).toMatchObject({ mount: "/data", pressureFreePct: 15, dailyHour: defaults.dailyHour, alertStepsPct: [80, 90, 95] });
    // An installed kit from before ADR-0068 has none of the new keys: the fallback fills them.
    const old = guardCfgFrom({ mount: "/", dailyHour: 4 } as never);
    expect(old).toMatchObject({ mount: "/", dailyHour: 4, ...DISK_GUARD_FALLBACK });
  });

  test("a broken value (a step out of range, a negative floor) falls back instead of disabling the guard", async () => {
    const { guardCfgFrom, DISK_GUARD_FALLBACK } = await import("../src/engine/disk-guard");
    const g = guardCfgFrom({ mount: "/", dailyHour: 4, alertStepsPct: [120, "x"], pressureFreePct: -3, alertRepeatMinutes: 0 } as never);
    expect(g.alertStepsPct).toEqual(DISK_GUARD_FALLBACK.alertStepsPct);
    expect(g.pressureFreePct).toBe(DISK_GUARD_FALLBACK.pressureFreePct);
    expect(g.alertRepeatMinutes).toBe(DISK_GUARD_FALLBACK.alertRepeatMinutes);
  });
});
