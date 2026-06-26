// The loop scheduler: a deterministic, AI-free tick. Each fire, it starts every loop whose trigger
// is due AND is enabled AND whose folder isn't already busy AND isn't throttled by the budget meter.
// lastRun is written BEFORE starting so a long loop spanning ticks never double-fires. The daemon
// runs tickScheduler on a 60s interval beside the idle watchdog (see daemon.ts).
import { isDue, type Trigger } from "./trigger";

export interface SchedulableLoop {
  name: string;
  folder: string;
  trigger: Trigger;
  enabledByDefault?: boolean;
}

export interface LoopStateStore {
  getLastRun(name: string): number | undefined;
  setLastRun(name: string, at: number): void;
  /** Explicit on/off override; undefined ⇒ use the loop's enabledByDefault. */
  isEnabled(name: string): boolean | undefined;
  setEnabled(name: string, on: boolean): void;
}

export interface TickDeps<T extends SchedulableLoop> {
  loops: T[];
  store: LoopStateStore;
  isFolderBusy: (folder: string) => boolean;
  throttled: () => boolean;
  now: number;
  start: (def: T) => void;
}

export function tickScheduler<T extends SchedulableLoop>(deps: TickDeps<T>): void {
  for (const def of deps.loops) {
    const enabled = deps.store.isEnabled(def.name) ?? def.enabledByDefault ?? false;
    if (!enabled) continue;
    if (!isDue(def.trigger, deps.store.getLastRun(def.name), deps.now)) continue;
    if (deps.isFolderBusy(def.folder)) continue;
    if (deps.throttled()) continue;
    deps.store.setLastRun(def.name, deps.now); // record before starting → no double-fire
    deps.start(def);
  }
}
