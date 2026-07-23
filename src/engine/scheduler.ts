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

/** Minimal shape `folderBusy` needs from the registry — decoupled from the concrete Registry type
 *  so this file (and its tests) never have to import registry.ts. */
export interface FolderLookup {
  findByFolder(folder: string): { status: string } | undefined;
}

/** Folder-busy predicate for `TickDeps.isFolderBusy`, company-folder aware. The company default
 *  project is ALWAYS registered — idle, not running — from startup (registerDefaultProject), so a
 *  plain presence check ("is ANY open session registered for this folder") would see the company
 *  folder as permanently busy and starve any loop scheduled against it (e.g. memory-dream) forever.
 *  For the company folder specifically, only a RUNNING session counts as busy; every other folder
 *  keeps the original presence semantics unchanged — an OPEN session (running OR idle) counts as
 *  busy, same as before this function existed (daemon.ts's inline `findByFolder(folder) !==
 *  undefined`). Callers must resolve a loop's folder (see loops.ts's resolveDreamLoop) BEFORE
 *  calling this — comparing against the unresolved "company" sentinel would never match
 *  `companyFolder` and this function would silently fall through to the presence branch. */
export function folderBusy(registry: FolderLookup, folder: string, companyFolder: string): boolean {
  const session = registry.findByFolder(folder);
  if (!session) return false;
  if (folder === companyFolder) return session.status === "running";
  return true;
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
