// The shared tools catalogue (ADR-0044): tool cards in `docs/tools/<id>.md` — YAML front matter plus a
// markdown body — and the validator that keeps them honest. Plain code, no AI. This file is the
// parse/validate half only; skill rendering, the `tool_api` relay and search build on `ToolCard` later.
//
// The validator collects EVERY error (never stops at the first), one `<file>: <field> …` line each.
// A card holds key NAMES only: an `env` entry that is not a name is an error, and the error never
// repeats the entry.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { safeFtsQuery } from "./memory-recall";
import { findSecret } from "./secret-patterns";

export type ToolKind = "mcp" | "cli" | "api" | "recipe";
export type CardStatus = "active" | "candidate" | "retired";
const KINDS: readonly ToolKind[] = ["mcp", "cli", "api", "recipe"];
const STATUSES: readonly CardStatus[] = ["active", "candidate", "retired"];

export interface RelayOperation {
  name: string;
  method: "GET" | "POST";
  path: string;
}

/** The api relay block (spec §2): where the engine may send a call for a worker, and with which key. */
export interface RelaySpec {
  baseUrl: string;
  authHeader: string;
  envKey: string;
  maxBodyBytes: number;
  operations: RelayOperation[];
}

export interface RecipeStep {
  card: string;
  do: string;
}

export interface ToolCard {
  id: string;
  kind: ToolKind;
  status: CardStatus;
  owner: string;
  when: string;
  /** "all" or the projects that may use the tool. */
  scope: "all" | string[];
  /** Key NAMES only. */
  env: string[];
  cost: string;
  limits: string;
  dataLeavesHost: boolean;
  tags: string[];
  examples: string[];
  /** Globs that map `tool_actions` rows to this card (spec A2). */
  usage?: { tools?: string[]; commands?: string[] };
  relay?: RelaySpec;
  steps?: RecipeStep[];
  body: string;
  file: string;
}

export interface ToolsCfg {
  /** The relay refuses everything until the operator sets this. */
  relayEnabled: boolean;
  maxCallsPerProjectPerDay: number;
  timeoutMs: number;
  maxReplyChars: number;
  /** The validator's cap on a card's `when`. */
  whenMaxChars: number;
  /** Where the cards live; a relative path resolves against Neo's folder. */
  catalogueDir: string;
  stopWords: string[];
  queryMaxTerms: number;
  minScore: number;
  usageWeight: number;
  usageCacheMs: number;
  showDisallowed: boolean;
  findLimit: number;
  /** Caps on the `tools_for` reply and on each match's `how`. */
  replyMaxChars: number;
  howMaxChars: number;
  hintMaxCards: number;
  hintMaxChars: number;
  hintPaths: string[];
  skillifyMin: number;
  /** What a worker inherits from the engine's own environment (ADR-0050 §7). `report` (default)
   *  removes only relay keys and lists the engine's key names; `strip` also removes them, except `inherit`. */
  workerEnv: { engineSecrets: "report" | "strip"; inherit: string[] };
}

export const DEFAULT_TOOLS_CFG: ToolsCfg = {
  relayEnabled: false, maxCallsPerProjectPerDay: 200, timeoutMs: 20_000, maxReplyChars: 20_000, whenMaxChars: 300,
  catalogueDir: "docs/tools",
  stopWords: ["a", "an", "and", "the", "to", "of", "in", "on", "for", "with", "is", "it", "this", "that", "do", "use", "me", "my", "please"],
  queryMaxTerms: 24, minScore: 0.5, usageWeight: 0.3, usageCacheMs: 600_000, showDisallowed: false, findLimit: 5,
  replyMaxChars: 4000, howMaxChars: 400, hintMaxCards: 3, hintMaxChars: 500, hintPaths: ["dispatch"], skillifyMin: 3,
  workerEnv: { engineSecrets: "report", inherit: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "OPENAI_API_KEY"] },
};

/** Config `tools` from config.json: a value of the right type is kept (numbers: finite and positive,
 *  `usageWeight` may be 0), anything else is the default. */
export function readToolsCfg(raw: unknown): ToolsCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULT_TOOLS_CFG };
  for (const [k, d] of Object.entries(DEFAULT_TOOLS_CFG)) {
    const v = r[k];
    if (k === "workerEnv") {
      const w = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      const dw = DEFAULT_TOOLS_CFG.workerEnv;
      out[k] = {
        engineSecrets: w.engineSecrets === "strip" || w.engineSecrets === "report" ? w.engineSecrets : dw.engineSecrets,
        inherit: Array.isArray(w.inherit) && w.inherit.every((x) => typeof x === "string") ? [...(w.inherit as string[])] : [...dw.inherit],
      };
    } else if (typeof d === "number") {
      if (typeof v === "number" && Number.isFinite(v) && (v > 0 || (k === "usageWeight" && v === 0))) out[k] = v;
    } else if (typeof d === "boolean") {
      if (typeof v === "boolean") out[k] = v;
    } else if (typeof d === "string") {
      if (typeof v === "string" && v.trim()) out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = [...v];
    }
  }
  return out as unknown as ToolsCfg;
}

export interface ParseResult {
  card?: ToolCard;
  errors: string[];
  /** The `id` the front matter declared, even when the card is invalid (for the duplicate check). */
  id?: string;
}

const ID_RE = /^[a-z0-9-]{2,40}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;
const MAX_TAGS = 12;
const MAX_EXAMPLES = 6;
const MIN_STEPS = 2;
const MAX_STEPS = 10;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Parse one card file and check every rule that needs only that file. */
export function parseCard(file: string, text: string, cfg: ToolsCfg): ParseResult {
  const errors: string[] = [];
  const err = (m: string) => errors.push(`${file}: ${m}`);
  const m = FRONT_RE.exec(text);
  if (!m) return { errors: [`${file}: front matter is missing`] };
  let fm: unknown;
  try {
    fm = Bun.YAML.parse(m[1]!);
  } catch {
    return { errors: [`${file}: front matter is not valid YAML`] };
  }
  if (!isObj(fm)) return { errors: [`${file}: front matter must be a mapping`] };
  const body = m[2] ?? "";

  const declaredId = typeof fm.id === "string" ? fm.id : undefined;
  if (!isStr(fm.id)) err("id is required");
  else {
    if (!ID_RE.test(fm.id)) err("id must be 2-40 chars of a-z, 0-9 and -");
    if (fm.id !== file.replace(/\.md$/, "")) err("id must match the file name");
  }
  const kind = fm.kind as ToolKind;
  if (fm.kind === undefined) err("kind is required");
  else if (!KINDS.includes(kind)) err(`kind must be one of ${KINDS.join(", ")}`);
  const status = fm.status as CardStatus;
  if (fm.status === undefined) err("status is required");
  else if (!STATUSES.includes(status)) err(`status must be one of ${STATUSES.join(", ")}`);
  for (const k of ["owner", "when", "cost", "limits"] as const) if (!isStr(fm[k])) err(`${k} is required`);
  if (isStr(fm.when) && fm.when.length > cfg.whenMaxChars) err(`when is longer than ${cfg.whenMaxChars} chars`);

  let scope: "all" | string[] = "all";
  if (fm.scope === undefined) err("scope is required");
  else if (fm.scope === "all") scope = "all";
  else if (strList(fm.scope) && fm.scope.length > 0 && fm.scope.every(isStr)) scope = fm.scope;
  else err("scope must be all or a list of projects");

  let env: string[] = [];
  if (fm.env === undefined) err("env is required");
  else if (!Array.isArray(fm.env)) err("env must be a list of key names");
  else {
    fm.env.forEach((e, i) => {
      // The entry itself is never put in the message: a pasted value must not travel into logs.
      if (typeof e !== "string" || ENV_NAME_RE.exec(e) === null || findSecret(e)) err(`env entry ${i + 1} is not a key name`);
    });
    env = fm.env.filter((e): e is string => typeof e === "string" && ENV_NAME_RE.exec(e) !== null);
  }
  if (typeof fm.dataLeavesHost !== "boolean") err("dataLeavesHost is required (true or false)");

  const active = status === "active";
  let tags: string[] = [];
  if (fm.tags === undefined) {
    if (active) err("tags is required on an active card");
  } else if (!strList(fm.tags)) err("tags must be a list of words");
  else {
    tags = fm.tags;
    if (active && tags.length === 0) err("tags is required on an active card");
    if (tags.length > MAX_TAGS) err(`tags has more than ${MAX_TAGS} entries`);
    tags.forEach((t, i) => { if (TAG_RE.exec(t) === null) err(`tags entry ${i + 1} must be a lowercase word`); });
  }
  let examples: string[] = [];
  if (fm.examples === undefined) {
    if (active) err("examples is required on an active card");
  } else if (!strList(fm.examples)) err("examples must be a list of one-line tasks");
  else {
    examples = fm.examples;
    if (active && examples.length === 0) err("examples is required on an active card");
    if (examples.length > MAX_EXAMPLES) err(`examples has more than ${MAX_EXAMPLES} entries`);
    examples.forEach((e, i) => { if (!isStr(e) || e.includes("\n")) err(`examples entry ${i + 1} must be one line`); });
  }

  let usage: ToolCard["usage"];
  if (fm.usage !== undefined) {
    if (!isObj(fm.usage) || (fm.usage.tools !== undefined && !strList(fm.usage.tools)) || (fm.usage.commands !== undefined && !strList(fm.usage.commands))) {
      err("usage must hold tools and/or commands as lists of globs");
    } else usage = { ...(fm.usage.tools ? { tools: fm.usage.tools as string[] } : {}), ...(fm.usage.commands ? { commands: fm.usage.commands as string[] } : {}) };
  }

  let relay: RelaySpec | undefined;
  if (fm.relay !== undefined) {
    if (kind !== "api") err("relay is only allowed on api cards");
    else relay = parseRelay(fm.relay, env, err);
  } else if (kind === "api" && active) err("relay is required on an active api card");

  let steps: RecipeStep[] | undefined;
  if (fm.steps !== undefined) {
    if (kind !== "recipe") err("steps is only allowed on recipe cards");
    else if (!Array.isArray(fm.steps) || fm.steps.length < MIN_STEPS || fm.steps.length > MAX_STEPS) err(`steps needs ${MIN_STEPS} to ${MAX_STEPS} entries`);
    else if (!fm.steps.every((s) => isObj(s) && isStr(s.card) && isStr(s.do))) err("steps entries need card and do");
    else steps = fm.steps.map((s) => ({ card: s.card as string, do: s.do as string }));
  } else if (kind === "recipe") err(`steps needs ${MIN_STEPS} to ${MAX_STEPS} entries`);

  if (!/^## How to call\s*$/m.test(body)) err("body needs a '## How to call' section");
  if (!/^## When NOT to use\s*$/m.test(body)) err("body needs a '## When NOT to use' section");

  if (errors.length) return { errors, id: declaredId };
  const card: ToolCard = {
    id: fm.id as string, kind, status, owner: fm.owner as string, when: fm.when as string, scope, env,
    cost: fm.cost as string, limits: fm.limits as string, dataLeavesHost: fm.dataLeavesHost as boolean,
    tags, examples, ...(usage ? { usage } : {}), ...(relay ? { relay } : {}), ...(steps ? { steps } : {}), body, file,
  };
  return { card, errors, id: declaredId };
}

function parseRelay(raw: unknown, env: string[], err: (m: string) => void): RelaySpec | undefined {
  if (!isObj(raw)) { err("relay must be a mapping"); return undefined; }
  const local: string[] = [];
  const bad = (m: string) => { local.push(m); err(m); };
  let baseUrl = "";
  if (!isStr(raw.baseUrl)) bad("relay.baseUrl is required");
  else {
    try {
      if (new URL(raw.baseUrl).protocol !== "https:") bad("relay.baseUrl must be https");
      else baseUrl = raw.baseUrl;
    } catch { bad("relay.baseUrl must be https"); }
  }
  if (!isStr(raw.authHeader)) bad("relay.authHeader is required");
  if (!isStr(raw.envKey)) bad("relay.envKey is required");
  else if (!env.includes(raw.envKey)) bad("relay.envKey must also be listed in env");
  if (typeof raw.maxBodyBytes !== "number" || !Number.isInteger(raw.maxBodyBytes) || raw.maxBodyBytes <= 0) bad("relay.maxBodyBytes must be a positive integer");
  const ops: RelayOperation[] = [];
  if (!Array.isArray(raw.operations) || raw.operations.length === 0) bad("relay.operations needs at least one entry");
  else {
    raw.operations.forEach((o, i) => {
      const at = `relay.operations entry ${i + 1}`;
      if (!isObj(o)) { bad(`${at} must be a mapping`); return; }
      if (!isStr(o.name)) bad(`${at} name is required`);
      if (o.method !== "GET" && o.method !== "POST") bad(`${at} method must be GET or POST`);
      if (!isStr(o.path) || !o.path.startsWith("/")) bad(`${at} path must start with /`);
      if (isStr(o.name) && (o.method === "GET" || o.method === "POST") && isStr(o.path) && o.path.startsWith("/")) ops.push({ name: o.name, method: o.method, path: o.path });
    });
  }
  if (local.length) return undefined;
  return { baseUrl, authHeader: raw.authHeader as string, envKey: raw.envKey as string, maxBodyBytes: raw.maxBodyBytes as number, operations: ops };
}

/** Load every `*.md` card in `dir`. Cross-file rules run after all cards are read: duplicate ids, and
 *  every recipe step must name an active card that is not itself a recipe. */
export function loadCards(dir: string, cfg: ToolsCfg): { cards: ToolCard[]; errors: string[] } {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== "README.md").map((d) => d.name).sort();
  } catch {
    return { cards: [], errors: [`${dir}: catalogue folder cannot be read`] };
  }
  const errors: string[] = [];
  const cards: ToolCard[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    let text: string;
    try { text = readFileSync(join(dir, name), "utf8"); } catch { errors.push(`${name}: file cannot be read`); continue; }
    const r = parseCard(name, text, cfg);
    errors.push(...r.errors);
    if (r.id) {
      const first = seen.get(r.id);
      if (first) errors.push(`${name}: id ${r.id} is already used by ${first}`);
      else seen.set(r.id, name);
    }
    if (r.card && seen.get(r.card.id) === name) cards.push(r.card);
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const c of cards) {
    c.steps?.forEach((s, i) => {
      const t = byId.get(s.card);
      const at = `${c.file}: steps entry ${i + 1}`;
      if (!t) errors.push(`${at} names a card that does not exist (${s.card})`);
      else if (t.kind === "recipe") errors.push(`${at} names a recipe (${s.card})`);
      else if (t.status !== "active") errors.push(`${at} names a card that is not active (${s.card})`);
    });
  }
  return { cards, errors };
}

// ---------------------------------------------------------------------------------------------
// The API relay (spec §4). A worker never holds an API key: it asks `relayCall`, and the engine adds the
// key from its own env. Every guard fails closed, in a fixed order; the first refusal is returned as plain
// text and NOTHING is sent. A reply, an event and a log line never hold a key value or the body.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_DEPTH = 20;

export interface RelayCtx {
  /** The calling project and folder — from the session, never from tool arguments. */
  project: string;
  folder: string;
  cfg: ToolsCfg;
  /** Where the key VALUES are read from (the engine's `process.env`). */
  env: Record<string, string | undefined>;
  ledger: Pick<import("./ledger").Ledger, "recordEvent" | "countEvents">;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}

/** True when some string (a value or a key, at any depth) in `v` matches a known secret shape. A body that
 *  nests deeper than the cap counts as a hit: fail closed. */
function bodyHoldsSecret(v: unknown, depth = 0): boolean {
  if (typeof v === "string") return findSecret(v) !== undefined;
  if (v === null || typeof v !== "object") return false;
  if (depth >= MAX_BODY_DEPTH) return true;
  if (Array.isArray(v)) return v.some((x) => bodyHoldsSecret(x, depth + 1));
  return Object.entries(v).some(([k, x]) => findSecret(k) !== undefined || bodyHoldsSecret(x, depth + 1));
}

/** Run one relayed API call. Always resolves to text; never throws. */
export async function relayCall(cards: readonly ToolCard[], cardId: string, op: string, body: unknown, ctx: RelayCtx): Promise<string> {
  const t0 = ctx.now();
  const audit = (extra: Record<string, unknown>): void => {
    try {
      ctx.ledger.recordEvent("tool_api", { folder: ctx.folder, at: t0, data: { card: cardId, operation: op, project: ctx.project, ...extra } });
    } catch { /* the audit trail never breaks a call */ }
  };
  const refuse = (check: number, why: string, record = true): string => {
    if (record) audit({ refused: `check ${check}` });
    return `tool_api refused (check ${check}: ${why})`;
  };

  if (!ctx.cfg.relayEnabled) return refuse(1, "the relay is disabled", false);
  const card = cards.find((c) => c.id === cardId);
  if (!card || card.status !== "active" || card.kind !== "api" || !card.relay) return refuse(2, "no active api card with that id");
  const relay = card.relay;
  const operation = relay.operations.find((o) => o.name === op);
  if (!operation) return refuse(3, `operation not declared on ${card.id}`);
  if (card.scope !== "all" && !card.scope.includes(ctx.project)) return refuse(4, `${card.id} is not available to this project`);
  let payload: string | undefined;
  try { payload = body === undefined ? undefined : JSON.stringify(body); } catch { return refuse(5, "body is not serialisable"); }
  const bytesOut = payload === undefined ? 0 : Buffer.byteLength(payload, "utf8");
  if (bytesOut > relay.maxBodyBytes) return refuse(5, `body is larger than ${relay.maxBodyBytes} bytes`);
  if (card.dataLeavesHost && bodyHoldsSecret(body)) return refuse(6, "the body looks like it holds a secret and this tool sends data off the host");
  const used = ctx.ledger.countEvents({ kind: "tool_api", project: ctx.project, unrefused: true, since: t0 - DAY_MS });
  if (used >= ctx.cfg.maxCallsPerProjectPerDay) return refuse(7, `daily cap of ${ctx.cfg.maxCallsPerProjectPerDay} relay calls reached`, false);
  const key = ctx.env[relay.envKey];
  if (!key) return refuse(8, `key ${relay.envKey} is not set`);

  const headers: Record<string, string> = { [relay.authHeader]: key, "content-type": "application/json" };
  let res: Response;
  try {
    // redirect: "manual" — a redirect would carry the key to another host.
    res = await ctx.fetch(relay.baseUrl.replace(/\/+$/, "") + operation.path, {
      method: operation.method,
      headers,
      ...(operation.method === "POST" && payload !== undefined ? { body: payload } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(ctx.cfg.timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    audit({ bytesOut, status: 0, ms: ctx.now() - t0, error: timedOut ? "timeout" : "network" });
    return `tool_api refused (${timedOut ? `timeout after ${ctx.cfg.timeoutMs} ms` : "network error"})`;
  }
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  audit({ bytesOut, status: res.status, ms: ctx.now() - t0 });
  const out = `HTTP ${res.status}\n${text}`;
  return out.length > ctx.cfg.maxReplyChars ? out.slice(0, ctx.cfg.maxReplyChars) + "\n[cut]" : out;
}

// ---------------------------------------------------------------------------------------------
// Tool search (spec A3). An in-memory FTS5 index over the ACTIVE cards and the installed skills'
// descriptions. The engine searches and counts; the worker judges. Plain code, no AI.

/** One installed skill: its id and its description (the "when to use"). */
export interface SkillRow {
  id: string;
  when: string;
}

/** Where skill descriptions come from: the filesystem in the daemon (`fsSkillSource`), a fake in tests.
 *  `project` reads the CALLING project's own skills only, so another project's skills never show. */
export interface SkillSource {
  global(): SkillRow[];
  project(folder: string): SkillRow[];
}

/** Per-card success counts and relay latency. The ledger adapter is ADR-0044 Phase 3; until then the
 *  daemon wires `nullUsage` (no counts, no p50, so no boost). */
export interface UsageSource {
  okUses(cardIds: string[]): Map<string, number>;
  p50(cardId: string): number | undefined;
}

export const nullUsage: UsageSource = { okUses: () => new Map(), p50: () => undefined };
const noSkills: SkillSource = { global: () => [], project: () => [] };

export interface ToolMatch {
  id: string;
  kind: ToolKind | "skill";
  title: string;
  /** The card's (or skill's) "when to use" line. */
  when: string;
  /** The query words that matched, per field: "tags: deploy, coolify". */
  why: string[];
  /** The first lines of "## How to call" (at most `cfg.howMaxChars`). */
  how: string;
  cost?: string;
  limits?: string;
  /** Only for relay cards that have calls. */
  p50Ms?: number;
  /** Scope check for the calling project. */
  allowed: boolean;
  reason?: string;
  score: number;
}

/** The opened catalogue a dispatch dep carries (ADR-0044): cards, search, and the API relay. */
export interface Catalogue {
  cards: readonly ToolCard[];
  errors: readonly string[];
  cfg: ToolsCfg;
  find(text: string, ctx: { project: string; folder: string; limit?: number }): ToolMatch[];
  /** Relay one call for the calling project. The key is read inside, from the engine's env. */
  relay(cardId: string, op: string, body: unknown, caller: { project: string; folder: string }): Promise<string>;
  /** The dispatch tools hint for a brief (spec A4): at most `hintMaxCards` lines `- <id> (<kind>): <when>` that the
   *  project may use, within `hintMaxChars`, ending with `Ask tools_for for more.`; "" when nothing scores. */
  hint(brief: string, ctx: { project: string; folder: string }): string;
}

const HINT_HEAD = "Tools that may help:";
const HINT_TAIL = "Ask tools_for for more.";

/** The `tools_for` reply text: one block per match, cut to `cfg.replyMaxChars`. */
export function formatToolsReply(matches: readonly ToolMatch[], cfg: ToolsCfg): string {
  if (matches.length === 0) return "no tool found for that task. Describe it with other words, or check the installed skills.";
  const blocks = matches.map((m) => {
    const lines = [`${m.id} · ${m.kind} · ${m.allowed ? "allowed" : `not allowed (${m.reason ?? "out of scope"})`}`];
    if (m.why.length) lines.push(`why: ${m.why.join("; ")}`);
    if (m.how) lines.push(`how: ${m.how}`);
    const extra = [m.cost ? `cost: ${m.cost}` : "", m.limits ? `limits: ${m.limits}` : "", m.p50Ms !== undefined ? `p50: ${m.p50Ms} ms` : ""].filter(Boolean);
    if (extra.length) lines.push(extra.join(" · "));
    return lines.join("\n");
  });
  const text = blocks.join("\n\n");
  return text.length > cfg.replyMaxChars ? text.slice(0, Math.max(0, cfg.replyMaxChars - 1)).trimEnd() + "…" : text;
}

const WORD_RE = /[\p{L}\p{N}]+/gu;
const MAX_TERM_CHARS = 40;
const MAX_MISS_TERMS = 24;
const MAX_FIND_LIMIT = 10;
/** The skills `tools/catalogue/install.ts` generates from the cards: indexing them would list a card twice. */
const OWN_SKILL_RE = /^neo-(tool|recipe)-/;
/** bm25 weights for (id, kind, when, tags, examples, body); id and kind are not searched. */
const WEIGHTS = "0, 0, 4.0, 3.0, 2.0, 1.0";

const words = (text: string): string[] => text.toLowerCase().match(WORD_RE) ?? [];

/** The first lines of the card's "## How to call" section, cut to `max` chars. */
function howToCall(body: string, max: number): string {
  const m = /^## How to call\s*$/m.exec(body);
  if (!m) return "";
  const rest = body.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  const section = (next ? rest.slice(0, next.index) : rest).trim();
  return section.length > max ? section.slice(0, max).trimEnd() + "…" : section;
}

type Row = { kind: ToolKind | "skill"; card?: ToolCard; id: string; when: string; tags: string; examples: string; body: string };

function cardRow(c: ToolCard): Row {
  const steps = c.steps?.map((s) => `${s.card} ${s.do}`).join("\n") ?? "";
  return { kind: c.kind, card: c, id: c.id, when: c.when, tags: c.tags.join(" "), examples: c.examples.join("\n"), body: steps ? `${c.body}\n${steps}` : c.body };
}
const skillRow = (r: SkillRow): Row => ({ kind: "skill", id: r.id, when: r.when, tags: "", examples: "", body: "" });

export function openCatalogue(o: {
  /** The cards folder. Optional only so a test can pass `cards` already loaded. */
  dir?: string;
  cards?: readonly ToolCard[];
  cfg: ToolsCfg;
  skills?: SkillSource;
  usage?: UsageSource;
  ledger: RelayCtx["ledger"];
  env?: RelayCtx["env"];
  fetch?: RelayCtx["fetch"];
  now?: () => number;
}): Catalogue {
  const cfg = o.cfg;
  const loaded = o.cards ? { cards: [...o.cards], errors: [] as string[] } : loadCards(o.dir ?? cfg.catalogueDir, cfg);
  const cards = loaded.cards;
  const skills = o.skills ?? noSkills;
  const usage = o.usage ?? nullUsage;
  const stop = new Set(cfg.stopWords.map((w) => w.toLowerCase()));

  // Index once. Rows keep the catalogue order (cards by file name, then global skills), which is the tie order.
  const db = new Database(":memory:");
  db.run(`CREATE VIRTUAL TABLE t USING fts5(id UNINDEXED, kind UNINDEXED, "when", tags, examples, body)`);
  db.run(`CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row')`);
  const rows: Row[] = []; // rowid - 1 -> row
  const insert = db.query(`INSERT INTO t (rowid, id, kind, "when", tags, examples, body) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const add = (r: Row, list: Row[], base: number): void => {
    list.push(r);
    insert.run(base + list.length, r.id, r.kind, r.when, r.tags, r.examples, r.body);
  };
  for (const c of cards) if (c.status === "active") add(cardRow(c), rows, 0);
  const globalSkillIds = new Set<string>();
  const addSkills = (list: SkillRow[], into: Row[], base: number, seenSkill: Set<string>): void => {
    for (const s of list) {
      if (OWN_SKILL_RE.test(s.id) || seenSkill.has(s.id)) continue;
      seenSkill.add(s.id);
      add(skillRow(s), into, base);
    }
  };
  try { addSkills(skills.global(), rows, 0, globalSkillIds); } catch { /* a skill source never breaks search */ }
  const bm25 = db.query(`SELECT rowid, -bm25(t, ${WEIGHTS}) AS s FROM t WHERE t MATCH ?`);
  const vocab = db.query(`SELECT term, doc FROM v`);

  const recordMiss = (project: string, folder: string, terms: string[]): void => {
    try { o.ledger.recordEvent("tools_miss", { folder, data: { project, terms } }); } catch { /* never breaks a search */ }
  };

  function find(text: string, ctx: { project: string; folder: string; limit?: number }): ToolMatch[] {
    // Query words: lowercase, stop words dropped, no secret-shaped or very long token, no repeats.
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const w of words(text)) {
      if (stop.has(w) || w.length > MAX_TERM_CHARS || seen.has(w)) continue;
      seen.add(w);
      if (findSecret(w)) continue;
      terms.push(w);
    }
    // What a miss records: the longest words, in query order, never more than 24.
    const missTerms = (): string[] => {
      const cap = Math.min(cfg.queryMaxTerms, MAX_MISS_TERMS);
      const keep = new Set(terms.map((t, i) => ({ t, i })).sort((a, b) => b.t.length - a.t.length || a.i - b.i).slice(0, cap).map((x) => x.i));
      return terms.filter((_, i) => keep.has(i));
    };
    const miss = (): ToolMatch[] => { recordMiss(ctx.project, ctx.folder, missTerms()); return []; };
    if (terms.length === 0) return miss();

    // The calling project's own skills go into the index for this call only: the transaction is rolled back.
    const projectRows: Row[] = [];
    let hits: Array<{ rowid: number; s: number }> = [];
    let used: string[] = [];
    try {
      db.run("BEGIN");
      try {
        try { addSkills(skills.project(ctx.folder), projectRows, rows.length, new Set(globalSkillIds)); } catch { /* skip */ }
        // Only words the index knows can match; keep the rarest queryMaxTerms, by FTS document frequency.
        const df = new Map((vocab.all() as Array<{ term: string; doc: number }>).map((r) => [r.term, r.doc]));
        used = terms.filter((t) => df.has(t)).sort((a, b) => df.get(a)! - df.get(b)! || (a < b ? -1 : 1)).slice(0, cfg.queryMaxTerms);
        if (used.length) hits = bm25.all(safeFtsQuery(used.join(" "), { mode: "any", stopWords: stop, maxTerms: cfg.queryMaxTerms })) as typeof hits;
      } finally {
        db.run("ROLLBACK");
      }
    } catch {
      return miss(); // a search error fails open to "nothing found"
    }
    if (hits.length === 0) return miss();

    const usedSet = new Set(used);
    const all = [...rows, ...projectRows];
    const cardIds = hits.map((h) => all[h.rowid - 1]?.card?.id).filter((x): x is string => !!x);
    let counts = new Map<string, number>();
    try { counts = usage.okUses(cardIds); } catch { /* no boost */ }
    const ranked = hits
      .map((h) => {
        const r = all[h.rowid - 1]!;
        const boost = r.card ? 1 + cfg.usageWeight * Math.log(1 + (counts.get(r.card.id) ?? 0)) : 1;
        return { r, rowid: h.rowid, score: h.s * boost };
      })
      .sort((a, b) => b.score - a.score || a.rowid - b.rowid);

    const out: ToolMatch[] = [];
    const limit = Math.min(Math.max(1, Math.floor(ctx.limit ?? cfg.findLimit)), MAX_FIND_LIMIT);
    for (const { r, score } of ranked) {
      const c = r.card;
      const allowed = !c || c.scope === "all" || c.scope.includes(ctx.project);
      if (!allowed && !cfg.showDisallowed) continue;
      const why: string[] = [];
      for (const [field, value] of [["when", r.when], ["tags", r.tags], ["examples", r.examples], ["body", r.body]] as const) {
        const here = new Set(words(value));
        const matched = terms.filter((t) => usedSet.has(t) && here.has(t)); // query order
        if (matched.length) why.push(`${field}: ${matched.join(", ")}`);
      }
      const p50 = c?.relay ? safe(() => usage.p50(c.id)) : undefined;
      out.push({
        id: r.id, kind: r.kind, title: r.id, when: r.when, why,
        how: c ? howToCall(c.body, cfg.howMaxChars) : `Load the skill "${r.id}".`,
        ...(c ? { cost: c.cost, limits: c.limits } : {}),
        ...(p50 !== undefined ? { p50Ms: p50 } : {}),
        allowed, ...(allowed ? {} : { reason: `only for projects: ${(c!.scope as string[]).join(", ")}` }),
        score,
      });
    }
    if (out.length === 0 || Math.max(...out.map((m) => m.score)) < cfg.minScore) return miss();
    return out.slice(0, limit);
  }

  function hint(brief: string, ctx: { project: string; folder: string }): string {
    if (cfg.hintMaxCards < 1) return "";
    const found = find(brief, { ...ctx, limit: cfg.hintMaxCards }).filter((m) => m.allowed).slice(0, cfg.hintMaxCards);
    const lines: string[] = [];
    const size = (l: string[]): number => [HINT_HEAD, ...l, HINT_TAIL].join("\n").length;
    for (const m of found) {
      const prefix = `- ${m.id} (${m.kind}): `;
      let line = prefix + m.when.replace(/\s+/g, " ").trim();
      const room = cfg.hintMaxChars - size(lines) - 1; // the newline this line adds
      if (line.length > room) {
        if (room < prefix.length + 8) break;
        line = line.slice(0, room - 1).trimEnd() + "…";
      }
      lines.push(line);
    }
    if (lines.length === 0) return "";
    return [HINT_HEAD, ...lines, HINT_TAIL].join("\n") + "\n\n";
  }

  return {
    cards,
    errors: loaded.errors,
    cfg,
    find,
    hint,
    relay: (cardId, op, body, caller) =>
      relayCall(cards, cardId, op, body, {
        ...caller, cfg, env: o.env ?? process.env, ledger: o.ledger,
        fetch: o.fetch ?? ((url, init) => fetch(url, init)), now: o.now ?? Date.now,
      }),
  };
}

function safe<T>(f: () => T): T | undefined {
  try { return f(); } catch { return undefined; }
}
