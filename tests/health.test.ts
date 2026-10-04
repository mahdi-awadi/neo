import { test, expect } from "bun:test";
import { createHealthMonitor, type HealthCfg } from "../src/engine/health";

const CFG: HealthCfg = { everyMs: 60_000, lagWarnMs: 2_000, rssWarnMb: 1_024 };

function rig() {
  const out: string[] = [];
  let rss = 100 * 1024 * 1024;
  let dbOk = true;
  const m = createHealthMonitor({
    cfg: () => CFG,
    rssBytes: () => rss,
    dbPing: () => {
      if (!dbOk) throw new Error("database is locked");
    },
    report: (t) => void out.push(t),
  });
  return { m, out, setRss: (mb: number) => void (rss = mb * 1024 * 1024), setDb: (ok: boolean) => void (dbOk = ok) };
}

test("healthy samples say nothing", () => {
  const x = rig();
  x.m.sample({ lagMs: 10 });
  x.m.sample({ lagMs: 10 });
  expect(x.out).toEqual([]);
});

test("each metric reports once when it degrades and once when it recovers", () => {
  const x = rig();
  x.m.sample({ lagMs: 5_000 });
  x.m.sample({ lagMs: 6_000 }); // still degraded: no repeat
  expect(x.out).toHaveLength(1);
  expect(x.out[0]).toContain("event-loop lag 5000ms");
  x.m.sample({ lagMs: 5 });
  expect(x.out[1]).toContain("recovered");

  x.setRss(2_048);
  x.setDb(false);
  x.m.sample({ lagMs: 5 });
  expect(x.out.slice(2).join("\n")).toContain("memory 2048 MB");
  expect(x.out.slice(2).join("\n")).toContain("ledger unreachable: database is locked");
});

test("a sample never throws", () => {
  const m = createHealthMonitor({
    cfg: () => CFG,
    rssBytes: () => {
      throw new Error("no rss");
    },
    dbPing: () => {},
    report: () => {
      throw new Error("channel down");
    },
  });
  expect(() => m.sample({ lagMs: 99_999 })).not.toThrow();
});
