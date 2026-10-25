// The shared tools catalogue (ADR-0044): tool cards in `docs/tools/<id>.md` — YAML front matter plus a
// markdown body — and the validator that keeps them honest. Plain code, no AI. This file is the
// parse/validate half only; skill rendering, the `tool_api` relay and search build on `ToolCard` later.
//
// The validator collects EVERY error (never stops at the first), one `<file>: <field> …` line each.
// A card holds key NAMES only: an `env` entry that is not a name is an error, and the error never
// repeats the entry.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
}

export const DEFAULT_TOOLS_CFG: ToolsCfg = {
  relayEnabled: false, maxCallsPerProjectPerDay: 200, timeoutMs: 20_000, maxReplyChars: 20_000, whenMaxChars: 300,
  catalogueDir: "docs/tools",
  stopWords: ["a", "an", "and", "the", "to", "of", "in", "on", "for", "with", "is", "it", "this", "that", "do", "use", "me", "my", "please"],
  queryMaxTerms: 24, minScore: 0.5, usageWeight: 0.3, usageCacheMs: 600_000, showDisallowed: false, findLimit: 5,
  replyMaxChars: 4000, howMaxChars: 400, hintMaxCards: 3, hintMaxChars: 500, hintPaths: ["dispatch"], skillifyMin: 3,
};

/** Config `tools` from config.json: a value of the right type is kept (numbers: finite and positive,
 *  `usageWeight` may be 0), anything else is the default. */
export function readToolsCfg(raw: unknown): ToolsCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULT_TOOLS_CFG };
  for (const [k, d] of Object.entries(DEFAULT_TOOLS_CFG)) {
    const v = r[k];
    if (typeof d === "number") {
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
  const used = ctx.ledger.countEvents({ kind: "tool_api", folder: ctx.folder, since: t0 - DAY_MS });
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
    audit({ bytesOut, status: 0, ms: ctx.now() - t0, refused: timedOut ? "timeout" : "network" });
    return `tool_api refused (${timedOut ? `timeout after ${ctx.cfg.timeoutMs} ms` : "network error"})`;
  }
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  audit({ bytesOut, status: res.status, ms: ctx.now() - t0 });
  const out = `HTTP ${res.status}\n${text}`;
  return out.length > ctx.cfg.maxReplyChars ? out.slice(0, ctx.cfg.maxReplyChars) + "\n[cut]" : out;
}

/** The opened catalogue a dispatch dep carries (ADR-0044). Phase 2 widens it with search. */
export interface Catalogue {
  cards: readonly ToolCard[];
  cfg: ToolsCfg;
  /** Relay one call for the calling project. The key is read inside, from the engine's env. */
  relay(cardId: string, op: string, body: unknown, caller: { project: string; folder: string }): Promise<string>;
}

export function createCatalogue(o: {
  cards: readonly ToolCard[];
  cfg: ToolsCfg;
  ledger: RelayCtx["ledger"];
  env?: RelayCtx["env"];
  fetch?: RelayCtx["fetch"];
  now?: () => number;
}): Catalogue {
  return {
    cards: o.cards,
    cfg: o.cfg,
    relay: (cardId, op, body, caller) =>
      relayCall(o.cards, cardId, op, body, {
        ...caller, cfg: o.cfg, env: o.env ?? process.env, ledger: o.ledger,
        fetch: o.fetch ?? ((url, init) => fetch(url, init)), now: o.now ?? Date.now,
      }),
  };
}
