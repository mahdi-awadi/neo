// The `mcp` update source (ADR-0009): every MCP server a worker can reach — `~/.claude.json` (user
// and per-project entries), each project's `.mcp.json` under the work root, and Neo's own built-ins.
// Each server is CLASSIFIED once (`classifyServer`); only three kinds have something to apply:
//   • npm-global — a globally installed npm package Neo launches by command (playwright-mcp),
//   • docker     — an untagged / `:latest` image (`docker pull`; the old image id is the rollback),
//   • codebase-memory — the `codebase-memory-mcp` binary (checksum-verified download, `.bak` swap).
// Each is verified by STARTING it and listing its tools; a failed probe rolls it back at once.
// Remote HTTP servers and floating npx servers resolve at launch (nothing to apply); a version pinned
// in another project's tracked `.mcp.json` is reported, never edited (that change belongs to that
// project's own history). Nothing is applied while a session is running.
import { basename, join } from "node:path";
import type { ItemResult, McpLaunch, RunContext, UpdateSource, UpdateSys } from "./updater";
import { breakingLines, compareVersions } from "./updater";

const MIN = 60_000;
const TIMEOUTS = { query: MIN, install: 5 * MIN, pull: 10 * MIN };

/** A server entry as written in `~/.claude.json` / `.mcp.json`. */
export interface ServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export type ServerClass =
  | { kind: "remote"; id: string }
  | { kind: "npx-floating"; id: string }
  | { kind: "npx-pinned"; id: string; pkg: string; version: string }
  | { kind: "docker"; id: string; image: string }
  | { kind: "docker-pinned"; id: string; image: string }
  | { kind: "npm-global"; id: string; pkg: string }
  | { kind: "codebase-memory"; id: string }
  | { kind: "local"; id: string };

/** docker run flags that take no value. Every other flag without `=` consumes the next argument. */
const DOCKER_BARE_FLAGS = new Set(["-i", "-t", "-it", "-ti", "-d", "--rm", "--init", "--privileged", "--interactive", "--tty", "--detach"]);

/** `pkg@1.2.3` / `@scope/pkg@1.2.3` / `pkg` → name + version. */
function splitSpec(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec };
}

function dockerImage(args: string[]): string | undefined {
  const start = args.indexOf("run");
  for (let i = start + 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) return a;
    if (!DOCKER_BARE_FLAGS.has(a) && !a.includes("=")) i++; // skip the flag's value
  }
  return undefined;
}

export function classifyServer(s: ServerConfig, o: { npmGlobals: Record<string, string>; codebaseMemoryBin: string }): ServerClass {
  if (s.url || s.type === "http" || s.type === "sse") {
    let host = s.url ?? "?";
    try {
      host = new URL(s.url ?? "").host;
    } catch {
      // keep the raw value
    }
    return { kind: "remote", id: `remote:${host}` };
  }
  const cmd = s.command ?? "";
  const args = s.args ?? [];
  if (basename(cmd) === "npx") {
    const spec = args.find((a) => !a.startsWith("-")) ?? "";
    const { name, version } = splitSpec(spec);
    return version && version !== "latest" ? { kind: "npx-pinned", id: `npx:${name}`, pkg: name, version } : { kind: "npx-floating", id: `npx:${name}` };
  }
  if (basename(cmd) === "docker") {
    const image = dockerImage(args) ?? "?";
    const last = image.split("/").pop() ?? "";
    const tag = last.includes(":") ? last.split(":").pop() : undefined;
    const pinned = image.includes("@sha256:") || (tag !== undefined && tag !== "latest");
    return pinned ? { kind: "docker-pinned", id: `docker:${image}`, image } : { kind: "docker", id: `docker:${image}`, image };
  }
  if (o.npmGlobals[cmd]) return { kind: "npm-global", id: `npm:${o.npmGlobals[cmd]}`, pkg: o.npmGlobals[cmd] };
  if (cmd === o.codebaseMemoryBin || basename(cmd) === "codebase-memory-mcp") return { kind: "codebase-memory", id: "codebase-memory-mcp" };
  return { kind: "local", id: `cmd:${cmd}` };
}

export interface McpSourceDeps {
  sys: UpdateSys;
  /** `~/.claude.json`. */
  claudeJson: string;
  /** Project folders live here; each one's `.mcp.json` is read. */
  workRoot: string;
  /** Servers Neo attaches itself (dispatch.ts `neoMcpServers`). */
  builtins: Array<McpLaunch & { name: string }>;
  /** Command → the npm package that installs it globally. */
  npmGlobals: Record<string, string>;
  codebaseMemory: { bin: string; repo: string; asset: string };
  verifyTimeoutMs: number;
}

interface Found {
  cls: ServerClass;
  launch: McpLaunch;
  where: string[];
}

export function mcpSource(d: McpSourceDeps): UpdateSource {
  const { sys } = d;
  const exec = (cmd: string[], timeoutMs = TIMEOUTS.query) => sys.exec(cmd, { timeoutMs });
  const json = <T>(text: string | undefined): T | undefined => {
    try {
      return text ? (JSON.parse(text) as T) : undefined;
    } catch {
      return undefined;
    }
  };

  /** Every configured server, classified and de-duplicated by id. */
  const discover = (): Found[] => {
    const found = new Map<string, Found>();
    const add = (s: ServerConfig, where: string) => {
      const cls = classifyServer(s, { npmGlobals: d.npmGlobals, codebaseMemoryBin: d.codebaseMemory.bin });
      const hit = found.get(cls.id);
      if (hit) hit.where.push(where);
      else found.set(cls.id, { cls, launch: { command: s.command ?? "", args: s.args ?? [], env: s.env }, where: [where] });
    };
    for (const b of d.builtins) add(b, `neo:${b.name}`);
    const user = json<{ mcpServers?: Record<string, ServerConfig>; projects?: Record<string, { mcpServers?: Record<string, ServerConfig> }> }>(sys.readFile(d.claudeJson));
    for (const [name, s] of Object.entries(user?.mcpServers ?? {})) add(s, `${d.claudeJson}:${name}`);
    for (const [proj, p] of Object.entries(user?.projects ?? {})) for (const [name, s] of Object.entries(p.mcpServers ?? {})) add(s, `${d.claudeJson}[${proj}]:${name}`);
    for (const dir of sys.listDir(d.workRoot)) {
      const file = join(d.workRoot, dir, ".mcp.json");
      const cfg = json<{ mcpServers?: Record<string, ServerConfig> }>(sys.readFile(file));
      for (const [name, s] of Object.entries(cfg?.mcpServers ?? {})) add(s, `${file}:${name}`);
    }
    return [...found.values()];
  };

  const npmLatest = async (pkg: string) => json<{ version?: string }>(await sys.fetchText(`https://registry.npmjs.org/${pkg}/latest`))?.version;

  /** Start the server and list its tools. Returns why it failed, or undefined. */
  const probe = async (launch: McpLaunch): Promise<string | undefined> => {
    const p = await sys.probeMcp(launch, d.verifyTimeoutMs);
    return p.ok && p.tools > 0 ? undefined : (p.error ?? "listed no tools");
  };

  // --- npm-global ---------------------------------------------------------------------------------
  const npmGlobal = async (f: Found, pkg: string, ctx: RunContext): Promise<ItemResult> => {
    const base: Omit<ItemResult, "outcome"> = { category: "mcp", id: f.cls.id };
    const ls = json<{ dependencies?: Record<string, { version?: string }> }>((await exec(["npm", "ls", "-g", pkg, "--json"])).out);
    const from = ls?.dependencies?.[pkg]?.version;
    const to = await npmLatest(pkg);
    if (!from || !to) return { ...base, from, outcome: "failed", detail: !from ? `${pkg} is not installed globally` : "npm registry unreachable" };
    if (compareVersions(to, from) <= 0) return { ...base, from, outcome: "up_to_date" };
    if (ctx.busy) return { ...base, from, to, outcome: "deferred", detail: "a session is running — applied when the engine is idle" };
    if (!ctx.autoApply) return { ...base, from, to, outcome: "available", detail: "auto-apply is off for mcp" };
    const inst = await exec(["npm", "i", "-g", `${pkg}@${to}`], TIMEOUTS.install);
    if (inst.code !== 0) return { ...base, from, to, outcome: "failed", detail: (inst.err || inst.out).trim().slice(-300) };
    const bad = await probe(f.launch);
    if (bad) {
      await exec(["npm", "i", "-g", `${pkg}@${from}`], TIMEOUTS.install);
      return { ...base, from, to, outcome: "rolled_back", detail: `${bad} — ${from} reinstalled` };
    }
    return { ...base, from, to, outcome: "applied", detail: "verified; new sessions start it", undo: { kind: "npm-global", pkg, version: from, launch: f.launch } };
  };

  // --- docker -------------------------------------------------------------------------------------
  const imageId = async (image: string) => {
    const r = await exec(["docker", "image", "inspect", "--format", "{{.Id}}", image]);
    return r.code === 0 ? r.out.trim() : undefined;
  };
  const short = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);
  const docker = async (f: Found, image: string, ctx: RunContext): Promise<ItemResult> => {
    const base: Omit<ItemResult, "outcome"> = { category: "mcp", id: f.cls.id };
    const old = await imageId(image);
    if (!old) return { ...base, outcome: "floating", detail: "image not pulled on this host — docker pulls it at first launch" };
    if (ctx.busy) return { ...base, from: short(old), outcome: "deferred", detail: "a session is running — pulled when the engine is idle" };
    if (!ctx.autoApply) return { ...base, from: short(old), outcome: "skipped", detail: "auto-apply is off for mcp" };
    const pull = await exec(["docker", "pull", image], TIMEOUTS.pull);
    if (pull.code !== 0) return { ...base, from: short(old), outcome: "failed", detail: (pull.err || pull.out).trim().slice(-300) };
    const now = await imageId(image);
    if (!now || now === old) return { ...base, from: short(old), outcome: "up_to_date" };
    const bad = await probe(f.launch);
    if (bad) {
      await exec(["docker", "tag", old, image]);
      return { ...base, from: short(old), to: short(now), outcome: "rolled_back", detail: `${bad} — the old image is tagged back` };
    }
    return { ...base, from: short(old), to: short(now), outcome: "applied", detail: "verified; new sessions start it", undo: { kind: "docker", image, oldId: old, launch: f.launch } };
  };

  // --- codebase-memory ----------------------------------------------------------------------------
  const cbm = d.codebaseMemory;
  const cbmVersion = async () => /(\d+\.\d+\.\d+)/.exec((await exec([cbm.bin, "--version"])).out)?.[1];
  const codebaseMemory = async (f: Found, ctx: RunContext): Promise<ItemResult> => {
    const base: Omit<ItemResult, "outcome"> = { category: "mcp", id: f.cls.id };
    const from = await cbmVersion();
    const releases = json<Array<{ tag_name: string; body?: string; draft?: boolean; prerelease?: boolean }>>(await sys.fetchText(`https://api.github.com/repos/${cbm.repo}/releases?per_page=30`)) ?? [];
    const stable = releases.filter((r) => !r.draft && !r.prerelease).map((r) => ({ v: r.tag_name.replace(/^v/, ""), tag: r.tag_name, body: r.body ?? "" }));
    const latest = stable.sort((a, b) => compareVersions(b.v, a.v))[0];
    if (!from || !latest) return { ...base, from, outcome: "failed", detail: !from ? `${cbm.bin} --version gave no version` : "GitHub releases unreachable" };
    const to = latest.v;
    if (compareVersions(to, from) <= 0) return { ...base, from, outcome: "up_to_date" };
    // GitHub notes are one body per release: read every release after `from`, up to `to`.
    const notes = stable.filter((r) => compareVersions(r.v, from) > 0 && compareVersions(r.v, to) <= 0).flatMap((r) => r.body.split("\n"));
    const breaking = breakingLines(notes);
    if (breaking.length && ctx.holdBreaking) return { ...base, from, to, outcome: "held", breaking, detail: `release notes flag a breaking change — /updates apply ${f.cls.id}` };
    if (ctx.busy) return { ...base, from, to, outcome: "deferred", detail: "a session is running — applied when the engine is idle" };
    if (!ctx.autoApply) return { ...base, from, to, outcome: "available", detail: "auto-apply is off for mcp" };

    const dir = `${cbm.bin}.update`;
    const url = `https://github.com/${cbm.repo}/releases/download/${latest.tag}`;
    const tarball = join(dir, cbm.asset);
    const fail = async (detail: string): Promise<ItemResult> => {
      await exec(["rm", "-rf", dir]);
      return { ...base, from, to, outcome: "failed", breaking: breaking.length ? breaking : undefined, detail };
    };
    await exec(["mkdir", "-p", dir]);
    if (!(await sys.download(`${url}/${cbm.asset}`, tarball))) return fail(`download of ${cbm.asset} failed`);
    const sums = (await sys.fetchText(`${url}/checksums.txt`)) ?? "";
    const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === cbm.asset)?.[0];
    if (!want || sys.sha256(tarball) !== want) return fail(`checksum of ${cbm.asset} does not match checksums.txt`);
    const untar = await exec(["tar", "-xzf", tarball, "-C", dir]);
    if (untar.code !== 0) return fail(`tar failed: ${untar.err.trim().slice(-200)}`);
    const binPath = (await exec(["find", dir, "-type", "f", "-name", "codebase-memory-mcp"])).out.split("\n")[0]?.trim();
    if (!binPath) return fail("the archive holds no codebase-memory-mcp binary");
    await exec(["chmod", "+x", binPath]);
    const bak = `${cbm.bin}.bak`;
    sys.copyFile(cbm.bin, bak);
    sys.rename(binPath, cbm.bin); // atomic on one filesystem; running servers keep the old inode
    await exec(["rm", "-rf", dir]);
    const got = await cbmVersion();
    const bad = got !== to ? `the new binary reports ${got ?? "no version"}` : await probe({ command: cbm.bin, args: [] });
    if (bad) {
      sys.copyFile(bak, cbm.bin);
      return { ...base, from, to, outcome: "rolled_back", detail: `${bad} — ${from} restored` };
    }
    return {
      ...base,
      from,
      to,
      outcome: "applied",
      breaking: breaking.length ? breaking : undefined,
      detail: `verified; new sessions start it (old binary kept as ${bak})`,
      undo: { kind: "codebase-memory", bak },
    };
  };

  const one = async (f: Found, ctx: RunContext): Promise<ItemResult> => {
    const base: Omit<ItemResult, "outcome"> = { category: "mcp", id: f.cls.id };
    switch (f.cls.kind) {
      case "remote":
        return { ...base, outcome: "floating", detail: "remote server — nothing to update here" };
      case "npx-floating":
        return { ...base, outcome: "floating", detail: "npx resolves it at launch" };
      case "docker-pinned":
        return { ...base, outcome: "report_only", detail: `pinned image in ${f.where.join(", ")}` };
      case "local":
        return { ...base, outcome: "report_only", detail: `local command, not managed (${f.where.join(", ")})` };
      case "npx-pinned": {
        const to = await npmLatest(f.cls.pkg);
        if (to && compareVersions(to, f.cls.version) > 0) {
          return { ...base, from: f.cls.version, to, outcome: "report_only", detail: `pinned in ${f.where.join(", ")} — bump it in that project` };
        }
        return { ...base, from: f.cls.version, outcome: "up_to_date" };
      }
      case "npm-global":
        return npmGlobal(f, f.cls.pkg, ctx);
      case "docker":
        return docker(f, f.cls.image, ctx);
      case "codebase-memory":
        return codebaseMemory(f, ctx);
    }
  };

  return {
    category: "mcp",
    async run(ctx) {
      const out: ItemResult[] = [];
      for (const f of discover()) {
        if (ctx.only && ctx.only !== f.cls.id && ctx.only !== "mcp") continue;
        try {
          out.push(await one(f, ctx));
        } catch (e) {
          out.push({ category: "mcp", id: f.cls.id, outcome: "failed", detail: e instanceof Error ? e.message : String(e) });
        }
      }
      return out;
    },
    async rollback(last) {
      const u = (last.undo ?? {}) as { kind?: string; pkg?: string; version?: string; image?: string; oldId?: string; bak?: string; launch?: McpLaunch };
      const base: Omit<ItemResult, "outcome"> = { category: "mcp", id: last.id, from: last.to, to: last.from };
      if (u.kind === "npm-global" && u.pkg && u.version) {
        const r = await exec(["npm", "i", "-g", `${u.pkg}@${u.version}`], TIMEOUTS.install);
        return r.code === 0 ? { ...base, outcome: "rolled_back", detail: `${u.version} reinstalled` } : { ...base, outcome: "failed", detail: (r.err || r.out).trim().slice(-300) };
      }
      if (u.kind === "docker" && u.image && u.oldId) {
        const r = await exec(["docker", "tag", u.oldId, u.image]);
        return r.code === 0 ? { ...base, outcome: "rolled_back", detail: "the old image is tagged back" } : { ...base, outcome: "failed", detail: (r.err || "docker tag failed").trim() };
      }
      if (u.kind === "codebase-memory" && u.bak) {
        if (!sys.exists(u.bak)) return { ...base, outcome: "failed", detail: `${u.bak} is gone` };
        sys.copyFile(u.bak, cbm.bin);
        return { ...base, outcome: "rolled_back", detail: `${u.bak} restored` };
      }
      return { ...base, outcome: "failed", detail: "no rollback point recorded" };
    },
  };
}
