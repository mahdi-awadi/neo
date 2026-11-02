/** The disk guard's heartbeat step (ADR-0068): connects the pure guard (`disk-guard.ts`) to the installed
 *  disk kit (ADR-0040/0041) — its config (`loadDiskConfig`), its run lock and its `state/last-run.json` —
 *  and to the engine: state in the ledger's meta (with an in-memory copy, so a full disk that refuses the
 *  write cannot turn every tick into an alert), events, and the operator alert. The kit's Tier A run starts
 *  in its own systemd unit (`neo-disk-tier-a`): its own cgroup, so a daemon restart does not kill it
 *  mid-run, one instance at a time, and its output in the journal. Without systemd-run it falls back to a
 *  detached child. Always an argv, never a shell. */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "./ledger";
import { diskUse, loadDiskConfig, type Sh } from "../../tools/disk/cleanup";
import { guardCfgFrom, runDiskGuard, type DiskGuardCfg, type DiskGuardState } from "./disk-guard";

/** The ledger meta key that holds the guard's state across ticks and restarts. */
export const DISK_GUARD_META = "disk:guard";
/** The systemd unit a Tier A run gets. */
export const TIER_A_UNIT = "neo-disk-tier-a";

export interface DiskGuardStepDeps {
  /** The installed kit (`bun tools/disk/install.ts`), e.g. ~/.local/share/neo/disk. */
  kitDir: string;
  ledger: Pick<Ledger, "getMeta" | "setMeta" | "recordEvent">;
  alert: (text: string) => void;
  /** Tests inject a `df` stand-in; production reads the mount with statfs (no child process). */
  sh?: Sh;
  spawn?: (argv: string[]) => void;
  now?: () => number;
  /** The bun binary that runs the kit (the daemon's own). */
  bunBin?: string;
}

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function readJson<T>(file: string): T | undefined {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Start the kit's run in its own systemd unit; a detached child only when systemd-run is not there. A unit
 *  that already exists is a run in progress: that throws (reported), it never starts a second run. */
export function startTierA(
  argv: string[],
  d: { run: (argv: string[]) => { ok: boolean; missing?: boolean; error?: string }; detached: (argv: string[]) => void },
): void {
  const r = d.run(["systemd-run", `--unit=${TIER_A_UNIT}`, "--collect", "--quiet", "--", ...argv]);
  if (r.ok) return;
  if (r.missing) return d.detached(argv);
  throw new Error(`systemd-run failed: ${r.error ?? "unknown error"}`);
}

const systemdRun = (argv: string[]): { ok: boolean; missing?: boolean; error?: string } => {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 15_000 });
  if (r.error) return { ok: false, missing: (r.error as NodeJS.ErrnoException).code === "ENOENT", error: r.error.message };
  return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300) };
};

const detachedChild = (argv: string[]): void => {
  const child = nodeSpawn(argv[0]!, argv.slice(1), { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // the pending-run timeout reports a run that never finished
  child.unref();
};

/** One heartbeat step; reads the kit's config each tick, so an edit applies without a restart. */
export function createDiskGuardStep(d: DiskGuardStepDeps): () => void {
  const now = d.now ?? Date.now;
  const state = join(d.kitDir, "state");
  let memory: DiskGuardState | undefined; // the newest state, also when the ledger refuses the write
  let lastFailure = ""; // a kit read failure is an event once, not every tick
  const usageOf = (mount: string) => {
    if (d.sh) {
      const u = diskUse(d.sh, mount);
      if (!u.size) throw new Error(`df gave no size for ${mount}`);
      return { size: u.size, used: u.used };
    }
    const s = statfsSync(mount);
    return { size: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
  };
  return () => {
    let cfg: DiskGuardCfg;
    let canRun = true;
    try {
      cfg = guardCfgFrom(loadDiskConfig(d.kitDir));
      lastFailure = "";
    } catch (e) {
      // The kit cannot be read: still watch and alert from the defaults, but start no run.
      cfg = guardCfgFrom({});
      canRun = false;
      const why = `disk kit not readable at ${d.kitDir}: ${e instanceof Error ? e.message : String(e)}`;
      if (why !== lastFailure) {
        lastFailure = why;
        try {
          d.ledger.recordEvent("disk_guard_failed", { data: { error: why } });
        } catch {
          // the event log itself failed: the guard still runs
        }
      }
    }
    runDiskGuard({
      cfg,
      canRun,
      usage: () => usageOf(cfg.mount),
      // The kit's own lock (cleanup.ts `run`): a live pid in state/run.lock. Read only, never created here.
      runActive: () => {
        const lock = join(state, "run.lock");
        return existsSync(lock) && pidAlive(Number(readFileSync(lock, "utf8").trim()));
      },
      loadState: () => memory ?? (d.ledger.getMeta(DISK_GUARD_META)?.value as DiskGuardState | undefined),
      saveState: (s) => {
        memory = s;
        try {
          d.ledger.setMeta(DISK_GUARD_META, s, now());
        } catch {
          // a full disk refuses the write; the in-memory copy carries the state until it can be saved
        }
      },
      spawnRun: d.spawn ?? ((argv) => startTierA(argv, { run: systemdRun, detached: detachedChild })),
      runArgv: [d.bunBin ?? process.execPath, join(d.kitDir, "cleanup.ts"), "run"],
      lastRun: () => readJson<{ at: number; freedBytes: number; afterPct?: number }>(join(state, "last-run.json")),
      alert: d.alert,
      event: (kind, data) => d.ledger.recordEvent(kind, { data }),
      now,
    });
  };
}
