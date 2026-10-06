/** The project probes (spec §9, P6 6.3), both optional per project and run in the repo scan:
 *  - health: GET `projects.<name>.healthUrl`; ok = a 2xx answer. Written to `probe:<project>`; the
 *    dashboard's pure health rule turns a failed probe into `down`.
 *  - deployed version: GET `deployedVersionUrl`, read the sha at `deployedVersionPath` (a dot path,
 *    default "version"), and count the commits on the deploy branch after it. Written to
 *    `deploy:<project>`; the dashboard shows "N commits not deployed" only from this row.
 *  Each HTTP call and git read is bounded by the scan's timeout (`github.callTimeoutMs`). A probe never
 *  throws and never guesses: any failure leaves the count out and names the error. Plain code, no AI. */
import type { GitRead } from "../git-read";
import type { ProjectCfg } from "./git";

/** What `probe:<project>` holds (the health probe). */
export interface ProbeMeta {
  at: number;
  ok: boolean;
  error?: string;
}

/** What `deploy:<project>` holds (the deployed-version probe). `undeployed` is set only when the
 *  deployed sha was read AND counted; otherwise `error` says why. */
export interface DeployMeta {
  at: number;
  /** The deploy branch the count is on. */
  branch?: string;
  /** The full deployed sha (as the repo names it). */
  sha?: string;
  /** Commits on `branch` after `sha`. */
  undeployed?: number;
  error?: string;
}

/** The dot path read from the deployed-version answer when `deployedVersionPath` is not set. */
export const DEFAULT_DEPLOYED_VERSION_PATH = "version";

/** The HTTP seam (global `fetch` by default; tests inject one). */
export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** A remote answer is untrusted: only a plain hex commit sha may reach git. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** The value at a dot path ("build.sha"; a number segment indexes an array). Undefined when any step
 *  is missing or the path is empty. */
export function shaAt(json: unknown, path: string): unknown {
  if (!path) return undefined;
  let o: unknown = json;
  for (const k of path.split(".")) {
    if (!k || o === null || typeof o !== "object") return undefined;
    o = (o as Record<string, unknown>)[k];
  }
  return o;
}

const message = (e: unknown, timeoutMs: number): string =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? `timeout after ${timeoutMs}ms` : e instanceof Error ? e.message : String(e);

/** One bounded GET: the response and its body text (read under the same timeout), or the error. */
async function get(fetch: Fetcher, url: string, timeoutMs: number, wantBody: boolean): Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!wantBody || res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: true, status: res.status, body: "" };
    }
    return { ok: true, status: res.status, body: await res.text() };
  } catch (e) {
    return { ok: false, error: message(e, timeoutMs) };
  }
}

const is2xx = (s: number): boolean => s >= 200 && s <= 299;

/** The health probe: ok = a 2xx answer within the timeout. */
export async function probeHealth(o: { url: string; timeoutMs: number; now: number; fetch?: Fetcher }): Promise<ProbeMeta> {
  const r = await get(o.fetch ?? fetch, o.url, o.timeoutMs, false);
  if (!r.ok) return { at: o.now, ok: false, error: r.error };
  return is2xx(r.status) ? { at: o.now, ok: true } : { at: o.now, ok: false, error: `HTTP ${r.status}` };
}

/** The deployed-version probe for one repo. `branch` is the deploy branch (config `deployBranch`, else
 *  the git producer's base branch); undefined = none known, an error. */
export async function probeDeploy(o: { read: GitRead; folder: string; cfg: ProjectCfg; branch: string | undefined; timeoutMs: number; now: number; fetch?: Fetcher }): Promise<DeployMeta> {
  const url = o.cfg.deployedVersionUrl;
  const path = o.cfg.deployedVersionPath ?? DEFAULT_DEPLOYED_VERSION_PATH;
  const fail = (error: string, extra: Partial<DeployMeta> = {}): DeployMeta => ({ at: o.now, ...(o.branch ? { branch: o.branch } : {}), ...extra, error });
  if (!url) return fail("no deployedVersionUrl");
  try {
    const r = await get(o.fetch ?? fetch, url, o.timeoutMs, true);
    if (!r.ok) return fail(r.error);
    if (!is2xx(r.status)) return fail(`HTTP ${r.status}`);
    let json: unknown;
    try {
      json = JSON.parse(r.body);
    } catch {
      return fail("the answer is not JSON");
    }
    const value = shaAt(json, path);
    if (value === undefined) return fail(`no value at "${path}"`);
    if (typeof value !== "string" || !SHA_RE.test(value)) return fail(`the value at "${path}" is not a commit sha`);
    if (!o.branch) return fail("no deploy branch known (set deployBranch)");
    const sha = value.toLowerCase();
    // The sha is plain hex (checked above), so neither argument can read as an option.
    const full = await o.read.git(o.folder, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    if (!full.ok || !full.out.trim()) return fail(`deployed sha ${sha} is not in this repo (fetch it?)`);
    const fullSha = full.out.trim();
    const c = await o.read.git(o.folder, ["rev-list", "--count", `${fullSha}..${o.branch}`]);
    const n = Number(c.out.trim());
    if (!c.ok || !c.out.trim() || !Number.isInteger(n)) return fail(`could not count commits on ${o.branch} after ${sha.slice(0, 7)}${c.err ? ` (${c.err})` : ""}`, { sha: fullSha });
    return { at: o.now, branch: o.branch, sha: fullSha, undeployed: n };
  } catch (e) {
    return fail(message(e, o.timeoutMs));
  }
}
