// Host processes of ONE tool call (ADR-0058): found by the call's marker in /proc/<pid>/environ, walked
// as trees, and killed with a grace. Never by name — this host is shared (no pkill). The /proc reader
// and the signal sender are injectable, so the logic is tested without touching real processes.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { MARKER_ENV } from "./tool-calls";

export interface ProcFs {
  list(): number[];
  /** The NUL-separated environment, undefined when unreadable (gone, or not ours). */
  environ(pid: number): string | undefined;
  cmdline(pid: number): string[] | undefined;
  ppid(pid: number): number | undefined;
  cwd(pid: number): string | undefined;
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The real /proc. */
export const realProcFs: ProcFs = {
  list: () => {
    try {
      return readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
    } catch {
      return [];
    }
  },
  environ: (pid) => read(`/proc/${pid}/environ`),
  cmdline: (pid) => read(`/proc/${pid}/cmdline`)?.split("\0").filter(Boolean),
  // /proc/<pid>/stat: "pid (comm) state ppid …" — comm may hold spaces and parens, so read after the last ")".
  ppid: (pid) => {
    const s = read(`/proc/${pid}/stat`);
    const rest = s ? s.slice(s.lastIndexOf(")") + 2).split(" ") : undefined;
    return rest ? Number(rest[1]) : undefined;
  },
  cwd: (pid) => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  },
};

/** The processes whose environment carries exactly this call's marker. */
export function markedPids(fs: ProcFs, toolUseId: string): number[] {
  const want = `${MARKER_ENV}=${toolUseId}`;
  return fs.list().filter((pid) => (fs.environ(pid) ?? "").split("\0").includes(want));
}

/** `root` and every descendant of it. */
export function treeOf(fs: ProcFs, root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const pid of fs.list()) {
    const pp = fs.ppid(pid);
    if (pp !== undefined) kids.set(pp, [...(kids.get(pp) ?? []), pid]);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    if (out.includes(p)) continue;
    out.push(p);
    stack.push(...(kids.get(p) ?? []));
  }
  return out;
}

export interface KillOps {
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): boolean;
  alive(pid: number): boolean;
  graceMs: number;
  sleep(ms: number): Promise<void>;
}

/** The real signal sender and liveness check. */
export const realKill: Pick<KillOps, "signal" | "alive"> = {
  signal: (pid, sig) => {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

/** SIGTERM every pid; after the grace, SIGKILL the ones still alive. */
export async function killPids(pids: number[], o: KillOps): Promise<{ killed: number[]; survived: number[] }> {
  const uniq = [...new Set(pids)].filter((p) => p > 1 && p !== process.pid);
  for (const p of uniq) o.signal(p, "SIGTERM");
  const left = uniq.filter((p) => o.alive(p));
  if (left.length) {
    await o.sleep(o.graceMs);
    for (const p of left.filter((x) => o.alive(x))) o.signal(p, "SIGKILL");
  }
  return { killed: uniq.filter((p) => !o.alive(p)), survived: uniq.filter((p) => o.alive(p)) };
}
