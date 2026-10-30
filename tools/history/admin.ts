// The task history's admin commands (ADR-0066 plan task 18): what the verify step (task 20) and the operator
// run by hand. Every command goes through the engine code — the store, the adapters and the `TaskHistory`
// seam — never raw SQL and never a hand-made request with a key. The config and the keys come from the
// engine's loader (`loadConfig`, which reads `.env` into the environment); no key is ever printed.
//
//   bun tools/history/admin.ts status [--db <file>]
//       the services (with the step when one is off), the coverage of each tag, the verify-tag count,
//       pending point deletes and the writer lock
//   bun tools/history/admin.ts copy-ledger --to <file> [--from <ledger>]
//       a consistent copy through a read-only connection (the snapshot backup's `vacuumCopy`); refuses a
//       target inside data/ and a file that exists
//   bun tools/history/admin.ts backfill --ledger <copy> --db <file> [--verify]
//       index a ledger copy into a scratch store outside data/. With --verify the points go to the shared
//       collection under the verify tag (`<tag>~verify`), and only when it holds no other tag's points;
//       without it nothing goes to the shared index (the vectors stay in the scratch store)
//   bun tools/history/admin.ts verify-clean
//       delete the verify tag's points (the filter `m = <verify tag>`), then require a count of 0
//   bun tools/history/admin.ts forget <ref> --reason <text> [--db <file>]
//   bun tools/history/admin.ts rescan-secrets [--db <file>] [--dry-run]
//       forget each entry with a stored chunk that the secret finder matches now (the pattern is named, the
//       text never)
//
// `NEO_DIR=<folder>` names the Neo folder whose config, `.env` and `data/` are used (default: this checkout;
// the verify step in a worktree sets it to the live folder, which is only ever read). The data/ folders of
// both are protected.
//
// The model flags (`--embedder-url`, `--model`, `--revision`, `--dims`, `--key-env`) point backfill,
// verify-clean, status and eval at another embedder (the model comparison of the verify step).
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../../src/config";
import { vacuumCopy } from "../../src/engine/backup/run";
import { openLedger, LEDGER_PATH } from "../../src/engine/ledger";
import { findSecret } from "../../src/engine/secret-patterns";
import { HISTORY_DEFAULTS, type EmbedderCfg, type HistoryCfg } from "../../src/engine/history/defaults";
import { modelTag, openEmbedder, withTag, type Embedder } from "../../src/engine/history/embedder";
import { openTaskHistory, type IndexReport, type TaskHistory } from "../../src/engine/history/index";
import { backlogDrains } from "../../src/engine/history/runtime";
import { operatorStep } from "../../src/engine/history/services";
import { openHistoryStore, type HistoryStore } from "../../src/engine/history/store";
import { NoVectorIndex, openVectorIndex, type VectorIndex } from "../../src/engine/history/vector-index";

export interface AdminCtx {
  /** The Neo folder whose `data/` holds the live ledger and `history.db` (relative paths resolve here). */
  neoDir: string;
  /** Folders a copy or a scratch store is never written into (the live `data/`). */
  protectedDirs: string[];
  cfg: HistoryCfg;
  /** The environment after `loadConfig`: the adapters read the keys from it by name. */
  env: Record<string, string | undefined>;
  /** `workRoot` of the config (plan files are read inside it). */
  workRoot: string;
  out(line: string): void;
  now(): number;
  pid?: number;
}

const USAGE = [
  "usage: bun tools/history/admin.ts <command> [flags]",
  "  status [--db <file>]",
  "  copy-ledger --to <file> [--from <ledger>]",
  "  backfill --ledger <copy> --db <file> [--verify]",
  "  verify-clean",
  "  forget <ref> --reason <text> [--db <file>]",
  "  rescan-secrets [--db <file>] [--dry-run]",
  "  model flags: --embedder-url <url> --model <id> --revision <sha> --dims <n> --key-env <NAME>",
].join("\n");

/** The verify step's model tag: the real tag plus `~verify`, so its points never mix with live ones. */
export function verifyTag(tag: string): string {
  return `${tag}~verify`;
}

const OPTIONS = {
  db: { type: "string" }, to: { type: "string" }, from: { type: "string" }, ledger: { type: "string" }, reason: { type: "string" },
  verify: { type: "boolean" }, "dry-run": { type: "boolean" },
  "embedder-url": { type: "string" }, model: { type: "string" }, revision: { type: "string" }, dims: { type: "string" }, "key-env": { type: "string" },
} as const;
interface Flags {
  db?: string; to?: string; from?: string; ledger?: string; reason?: string; verify?: boolean; "dry-run"?: boolean;
  "embedder-url"?: string; model?: string; revision?: string; dims?: string; "key-env"?: string;
}

/** A command refused before it changed anything; the message says why. */
export class Refused extends Error {}
const refuse: (msg: string) => never = (msg) => {
  throw new Refused(msg);
};

/** The embedder config with the model flags applied (the comparison run points at another container). */
export function embedderFrom(flags: Partial<Record<"embedder-url" | "model" | "revision" | "dims" | "key-env", string>>, base: EmbedderCfg): EmbedderCfg {
  const dims = flags.dims === undefined ? base.dims : Number(flags.dims);
  if (!Number.isInteger(dims) || dims <= 0) refuse(`--dims must be a positive whole number`);
  return {
    ...base,
    ...(flags["embedder-url"] ? { url: flags["embedder-url"] } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.revision ? { revision: flags.revision } : {}),
    ...(flags["key-env"] ? { keyEnv: flags["key-env"] } : {}),
    dims,
  };
}

/** The real folder a path would be written in (a symlinked parent resolved), for the data/ check. */
function realTarget(path: string): string {
  const abs = resolve(path);
  let dir = dirname(abs);
  const rest: string[] = [basename(abs)];
  while (!existsSync(dir) && dirname(dir) !== dir) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  return join(existsSync(dir) ? realpathSync(dir) : dir, ...rest);
}

function inside(path: string, dir: string): boolean {
  const real = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  const rel = relative(real, realTarget(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** `path` (relative to the Neo folder) as an absolute path; refused when it is inside a protected folder. */
export function outsideData(ctx: Pick<AdminCtx, "neoDir" | "protectedDirs">, path: string, what: string): string {
  const abs = resolve(ctx.neoDir, path);
  for (const d of ctx.protectedDirs) if (inside(abs, d)) refuse(`${what} ${abs} is inside ${d}: use a scratch folder outside data/`);
  return abs;
}

const liveDb = (ctx: AdminCtx, flags: Flags): string => {
  const path = resolve(ctx.neoDir, flags.db ?? ctx.cfg.dbPath);
  if (!existsSync(path)) refuse(`no history store at ${path}`);
  return path;
};

/** Open the seam over one store, with the configured (or flagged) embedder and the shared index. */
function openSeam(ctx: AdminCtx, opts: { store: HistoryStore; embedder: Embedder; vectors: VectorIndex; ecfg: EmbedderCfg; ledgerPath?: string; events?: (kind: string) => void }): TaskHistory {
  const ledger = openLedger(opts.ledgerPath ?? ":memory:");
  return openTaskHistory({
    cfg: { ...ctx.cfg, embedder: opts.ecfg, next: null, dbPath: opts.store.path },
    ledger, workRoot: ctx.workRoot, env: ctx.env, store: opts.store, embedder: opts.embedder, vectors: opts.vectors,
    events: (kind) => opts.events?.(kind), now: ctx.now, ...(ctx.pid !== undefined ? { pid: ctx.pid } : {}),
  });
}

async function status(ctx: AdminCtx, flags: Flags): Promise<number> {
  const path = liveDb(ctx, flags);
  const ecfg = embedderFrom(flags, ctx.cfg.embedder);
  const embedder = openEmbedder(ecfg, ctx.env);
  const vectors = openVectorIndex(ctx.cfg.vectors, ctx.env, { dims: ecfg.dims });
  const store = openHistoryStore(path, ctx.cfg.store);
  const history = openSeam(ctx, { store, embedder, vectors, ecfg });
  try {
    ctx.out(`history.db ${path}`);
    const e = await embedder.probe();
    ctx.out(e.state === "up" ? `embedder: up (${ecfg.model}, ${ecfg.dims} dims)` : `embedder: ${e.state} ${e.reason} — ${operatorStep("embedder", e.reason, { ...ctx.cfg, embedder: ecfg })}`);
    const v = await vectors.probe(embedder.tag);
    ctx.out(v.state === "up" ? `vectors: up (${vectors.collection}, ${v.count} points of ${embedder.tag})` : `vectors: ${v.state} ${v.reason} — ${operatorStep("vectors", v.reason, { ...ctx.cfg, embedder: ecfg })}`);
    const s = history.status();
    for (const t of s.tags) ctx.out(`${t.role} ${t.tag}: coverage ${(t.coverage * 100).toFixed(1)}%`);
    const vt = verifyTag(embedder.tag);
    const verify = v.state === "up" ? await vectors.probe(vt) : undefined;
    ctx.out(`${vt}: ${verify?.state === "up" ? `${verify.count} points` : "not checked"}`);
    ctx.out(`pending point deletes: ${s.pendingDeletes}`);
    ctx.out(s.lock ? `writer lock: pid ${s.lock.pid} since ${new Date(s.lock.at).toISOString()}` : "writer lock: free");
    return 0;
  } finally {
    history.close();
  }
}

function copyLedger(ctx: AdminCtx, flags: Flags): number {
  if (!flags.to) return refuse("copy-ledger needs --to <file>");
  const from = resolve(ctx.neoDir, flags.from ?? LEDGER_PATH);
  const to = outsideData(ctx, flags.to, "the copy");
  if (existsSync(to)) refuse(`${to} exists: the copy never overwrites a file`);
  if (!existsSync(from)) refuse(`no ledger at ${from}`);
  vacuumCopy(from, to);
  ctx.out(`copied ${from} → ${to} (${statSync(to).size} bytes, mode 0600, read-only source)`);
  return 0;
}

async function backfill(ctx: AdminCtx, flags: Flags): Promise<number> {
  if (!flags.db) return refuse("backfill needs --db <file> outside data/");
  if (!flags.ledger) return refuse("backfill needs --ledger <copy> (make one with copy-ledger)");
  const db = outsideData(ctx, flags.db, "the store");
  const ledgerPath = outsideData(ctx, flags.ledger, "the ledger copy");
  if (!existsSync(ledgerPath)) refuse(`no ledger copy at ${ledgerPath}`);
  const ecfg = embedderFrom(flags, ctx.cfg.embedder);
  const base = openEmbedder(ecfg, ctx.env);
  const embedder = flags.verify ? withTag(base, verifyTag(base.tag)) : base;
  let vectors: VectorIndex = new NoVectorIndex("not_configured");
  if (flags.verify) {
    vectors = openVectorIndex(ctx.cfg.vectors, ctx.env, { dims: ecfg.dims });
    const mine = await vectors.probe(embedder.tag);
    if (mine.state !== "up") refuse(`the shared index is ${mine.state}: ${mine.reason}`);
    const all = await vectors.countAll();
    if (!all.ok) refuse(`the shared index is not counted: ${all.reason}`);
    const other = all.value - mine.count;
    if (other > 0) refuse(`${vectors.collection} holds ${other} point(s) of another tag: the verify run starts only on a collection with no other tag's points`);
  }
  const tally = new Map<string, number>();
  const store = openHistoryStore(db, ctx.cfg.store);
  const history = openSeam(ctx, { store, embedder, vectors, ecfg, ledgerPath, events: (k) => void tally.set(k, (tally.get(k) ?? 0) + 1) });
  const started = Date.now();
  const cpu = process.cpuUsage();
  const sum = { passes: 0, indexed: 0, chunks: 0, embedded: 0, uploaded: 0, uploadMs: 0 };
  let last: IndexReport | undefined;
  try {
    ctx.out(`backfill ${ledgerPath} → ${db} · tag ${embedder.tag}${flags.verify ? ` · ${vectors.collection}` : " · vectors stay local"}`);
    for (;;) {
      const r = await history.indexTick(ctx.now());
      last = r;
      sum.passes++;
      sum.indexed += r.sources.indexed;
      sum.chunks += r.chunks.added + r.chunks.changed;
      sum.embedded += r.embedded;
      sum.uploaded += r.uploaded;
      if (r.uploaded) sum.uploadMs += r.ms;
      if (sum.passes % 25 === 0) ctx.out(`  pass ${sum.passes}: sources ${sum.indexed} · chunks ${sum.chunks} · embedded ${sum.embedded} · uploaded ${sum.uploaded} · backlog ${JSON.stringify(r.backlog)}`);
      if (r.locked) refuse(`another process holds the writer lock of ${db}`);
      if (!backlogDrains(r)) break;
    }
    const ms = Date.now() - started;
    const used = process.cpuUsage(cpu);
    const s = history.status();
    ctx.out(`done in ${(ms / 1000).toFixed(1)} s · passes ${sum.passes} · sources ${sum.indexed} · chunks ${sum.chunks} · ${(sum.chunks / Math.max(ms / 1000, 0.001)).toFixed(1)} chunks/s`);
    ctx.out(`embedded ${sum.embedded} · uploaded ${sum.uploaded} (passes with uploads: ${(sum.uploadMs / 1000).toFixed(1)} s) · CPU ${((used.user + used.system) / 1e6).toFixed(1)} s`);
    ctx.out(`embedder ${last?.embedder.state ?? "?"}${last?.embedder.reason ? ` ${last.embedder.reason}` : ""} · vectors ${last?.vectors.state ?? "?"}${last?.vectors.reason ? ` ${last.vectors.reason}` : ""}`);
    for (const t of s.tags) ctx.out(`${t.role} ${t.tag}: coverage ${(t.coverage * 100).toFixed(1)}%`);
    if (tally.size) ctx.out(`events: ${[...tally].map(([k, n]) => `${k} ${n}`).join(" · ")}`);
    return 0;
  } finally {
    history.close();
  }
}

async function verifyClean(ctx: AdminCtx, flags: Flags): Promise<number> {
  const ecfg = embedderFrom(flags, ctx.cfg.embedder);
  const tag = verifyTag(modelTag(ecfg.model, ecfg.dims, ecfg.revision));
  const vectors = openVectorIndex(ctx.cfg.vectors, ctx.env, { dims: ecfg.dims });
  const del = await vectors.deleteTag(tag);
  if (!del.ok) ctx.out(`delete of ${tag} failed: ${del.reason}`);
  const left = await vectors.probe(tag);
  if (left.state !== "up") {
    ctx.out(`${tag}: not counted (${left.reason})`);
    return 1;
  }
  ctx.out(`${tag}: ${left.count} points in ${vectors.collection}`);
  return del.ok && left.count === 0 ? 0 : 1;
}

async function forget(ctx: AdminCtx, flags: Flags, ref: string | undefined): Promise<number> {
  if (!ref) return refuse("forget needs a ref (todo:884, plan:12, mem:3, …)");
  if (!flags.reason?.trim()) return refuse("forget needs --reason <text>");
  const path = liveDb(ctx, flags);
  const ecfg = embedderFrom(flags, ctx.cfg.embedder);
  const store = openHistoryStore(path, ctx.cfg.store);
  const history = openSeam(ctx, { store, embedder: openEmbedder(ecfg, ctx.env), vectors: openVectorIndex(ctx.cfg.vectors, ctx.env, { dims: ecfg.dims }), ecfg });
  try {
    const r = await history.forget(ref, flags.reason, ctx.now());
    if (!r.ok) {
      ctx.out(`not forgotten: ${r.error}`);
      return 1;
    }
    ctx.out(`forgot ${ref}: ${r.chunks} chunk(s), ${r.points} point(s)${r.pendingPoints ? `, ${r.pendingPoints} queued for the shared index` : ""}`);
    return 0;
  } finally {
    history.close();
  }
}

/** Chunks read per page while the rescan walks the store. */
const SCAN_PAGE = 500;

async function rescanSecrets(ctx: AdminCtx, flags: Flags): Promise<number> {
  const path = liveDb(ctx, flags);
  const ecfg = embedderFrom(flags, ctx.cfg.embedder);
  const store = openHistoryStore(path, ctx.cfg.store);
  const history = openSeam(ctx, { store, embedder: openEmbedder(ecfg, ctx.env), vectors: openVectorIndex(ctx.cfg.vectors, ctx.env, { dims: ecfg.dims }), ecfg });
  try {
    const found = new Map<string, string>();
    let scanned = 0;
    for (let after = 0; ; ) {
      const page = store.scanChunks(after, SCAN_PAGE);
      if (!page.length) break;
      for (const c of page) {
        const pattern = found.has(c.ref) ? undefined : findSecret(c.text);
        if (pattern) found.set(c.ref, pattern);
      }
      scanned += page.length;
      after = page.at(-1)!.id;
    }
    ctx.out(`scanned ${scanned} chunk(s): ${found.size} entr${found.size === 1 ? "y" : "ies"} with a secret shape`);
    let failed = 0;
    for (const [ref, pattern] of found) {
      if (flags["dry-run"]) {
        ctx.out(`  ${ref} ${pattern} (dry run: kept)`);
        continue;
      }
      const r = await history.forget(ref, `secret: ${pattern}`, ctx.now());
      if (!r.ok) failed++;
      ctx.out(`  ${ref} ${pattern} ${r.ok ? `forgotten (${r.chunks} chunk(s), ${r.points} point(s))` : `NOT forgotten: ${r.error}`}`);
    }
    return failed ? 1 : 0;
  } finally {
    history.close();
  }
}

/** Run one command. Returns the exit code: 0 done, 1 refused or failed, 2 usage. */
export async function runAdmin(argv: string[], ctx: AdminCtx): Promise<number> {
  let parsed: { values: Flags; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    ctx.out(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const [command, arg] = parsed.positionals;
  const flags = parsed.values;
  try {
    switch (command) {
      case "status":
        return await status(ctx, flags);
      case "copy-ledger":
        return copyLedger(ctx, flags);
      case "backfill":
        return await backfill(ctx, flags);
      case "verify-clean":
        return await verifyClean(ctx, flags);
      case "forget":
        return await forget(ctx, flags, arg);
      case "rescan-secrets":
        return await rescanSecrets(ctx, flags);
      default:
        ctx.out(USAGE);
        return 2;
    }
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    ctx.out(`refused: ${e.message}`);
    return 1;
  }
}

/** This checkout. */
const REPO = join(import.meta.dir, "..", "..");

/** The context of a real run: this checkout's config and `.env` through the engine's loader. */
export function realContext(neoDir = REPO): AdminCtx {
  const cfg = loadConfig(neoDir);
  return {
    neoDir, protectedDirs: [...new Set([join(neoDir, "data"), join(REPO, "data")])], cfg: cfg.history ?? HISTORY_DEFAULTS, env: process.env, workRoot: cfg.workRoot,
    out: (l) => console.log(l), now: Date.now,
  };
}

if (import.meta.main) process.exit(await runAdmin(process.argv.slice(2), realContext(process.env.NEO_DIR || undefined)));
