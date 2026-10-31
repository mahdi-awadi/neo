// Order sizes (ADR-0072): an order is `quick`, `standard` or `big`. The chief of staff sets the size, the
// operator's own message overrides it, and the upgrade guard only moves it up. This module is the size
// model — the sizes, the `sizes` config, the operator's override, `resolveSize`, the guard's rules and limits
// (`judgeTouch`) and every size text. Pure: no I/O, no ledger (size-guard.ts is the stateful adapter).
import type { LaneKind } from "./lanes";

/** The sizes, smallest first (CONTEXT.md "Order size"). */
export const ORDER_SIZES = ["quick", "standard", "big"] as const;
export type OrderSize = (typeof ORDER_SIZES)[number];
/** Who set a todo's size. */
export type SizeBy = "operator" | "company" | "engine";

export function isOrderSize(x: unknown): x is OrderSize {
  return typeof x === "string" && (ORDER_SIZES as readonly string[]).includes(x);
}

/** The larger of two sizes. */
export function larger(a: OrderSize, b: OrderSize): OrderSize {
  return ORDER_SIZES.indexOf(a) >= ORDER_SIZES.indexOf(b) ? a : b;
}

/** One move up (CONTEXT.md "Size up"). `from` is the size the order started at (kept across two moves). */
export interface SizeUp {
  from: OrderSize;
  to: OrderSize;
  /** "files" | "lines" | "services" | "plan" | "handoff" | a rule name (spec §5.2). */
  rule: string;
  path?: string;
  command?: string;
  value?: number;
  max?: number;
  /** Found by the measure at the run's end, after nothing could be stopped. */
  late?: boolean;
  at: number;
}

/** One guard rule (spec §5.2). A path matches on `paths` (globs on the folder-relative path), `names`
 *  (regex on the basename) or `words` (regex, a whole word of `pathWords(path)`); a command matches on
 *  `commands` (regex on its head). All regexes are case-insensitive. */
export interface SizeRule {
  name: string;
  to: OrderSize;
  paths?: string[];
  names?: string[];
  words?: string[];
  commands?: string[];
  /** Only new files match. */
  created?: boolean;
  /** Globs exempt from this rule. */
  except?: string[];
}

export interface SizeLimits {
  maxFiles: number;
  maxLines: number;
  maxServices: number;
}

/** The `sizes` config block (spec §10, docs/CONFIG.md). */
export interface SizesCfg {
  /** false → every order is big, with no guard and no override (before ADR-0072). */
  enabled: boolean;
  /** The size of an order nobody sized. */
  default: OrderSize;
  /** A side brief with no size gets its kind's size. */
  side: Record<LaneKind, OrderSize>;
  /** The operator's override phrases: a message that starts with one sets the size. */
  override: { quick: string[]; big: string[] };
  quick: SizeLimits & { resultMaxLines: number; noNewFiles: string[] };
  standard: SizeLimits;
  guard: { rules: SizeRule[]; serviceMarkers: string[]; ignore: string[] };
  /** An attention kind's size, over its brief's own (spec §9). */
  attention: Record<string, OrderSize>;
  /** A project's own rules and global exemptions. */
  projects: Record<string, { rules: SizeRule[]; except: string[] }>;
}

// The tools that move a database schema, run through a package script, a runner or a script file.
const RUNNER = "(?:make|just|task|(?:bun|npm|pnpm|yarn)(?:\\s+run)?)";

/** The default rules (spec §5.2): the sensitive areas move an order to big, an API contract and the
 *  dependencies to standard. */
const DEFAULT_RULES: SizeRule[] = [
  { name: "migration", to: "big",
    paths: ["**/migrations/**", "**/migration/**", "**/migrate/**", "**/schema.prisma", "**/drizzle/**", "**/alembic/**"],
    words: ["migrat\\w*"],
    commands: ["^(?:goose|migrate|atlas|dbmate|flyway|liquibase|alembic)\\b",
               "^(?:(?:npx|bunx)\\s+)?(?:prisma|drizzle-kit|knex|sequelize|typeorm|sqlx)\\b.*\\bmigrat",
               `^${RUNNER}\\s+\\S*migrat`,
               "^(?:go\\s+run|node|bun|deno|python3?|sh|bash)\\s+\\S*migrat"] },
  { name: "auth", to: "big",
    words: ["o?auth(?!or(?!i[sz]))\\w*", "jwt\\w*", "login\\w*", "logout", "sign(?:in|up|on|out)", "sessions?",
            "passwords?", "passwd", "permissions?", "roles?", "rbac", "acl", "otp", "mfa", "2fa", "totp", "identity",
            "credentials?", "csrf", "sso", "saml", "oidc"] },
  { name: "money", to: "big",
    words: ["payments?", "pay", "payouts?", "billing", "wallets?", "invoices?", "refunds?", "finance", "financial",
            "balances?", "prices?", "pricing", "fares?", "commissions?", "markups?", "settlements?", "checkout",
            "currenc(?:y|ies)", "money", "charges?", "receipts?", "tax(?:es)?", "discounts?", "coupons?", "topups?"] },
  { name: "secrets", to: "big",
    paths: ["**/secrets/**", ".security/**"],
    names: ["^\\.env(?:\\.(?!example$|sample$|template$|dist$)[^/]+)?$", "\\.(?:pem|key|p12|pfx|jks|keystore)$",
            "^id_(?:rsa|ed25519|ecdsa)", "^credentials", "^\\.(?:npmrc|netrc|pypirc)$"],
    words: ["secrets?", "vault"] },
  { name: "deploy", to: "big",
    paths: [".github/**", ".gitlab/**", ".circleci/**", ".husky/**", "**/k8s/**", "**/kubernetes/**", "**/helm/**",
            "**/charts/**", "**/ansible/**", "**/terraform/**", "**/infra/**", "**/infrastructure/**", "**/deploy/**",
            "**/deployment/**", "**/*.tf", "**/*.tfvars"],
    names: ["^(?:Dockerfile|Containerfile)(?:\\..+)?$", "^(?:docker-)?compose(?:\\.[\\w-]+)*\\.ya?ml$",
            "^\\.gitlab-ci\\.ya?ml$", "^\\.drone\\.ya?ml$", "^Jenkinsfile$", "^Procfile$",
            "^(?:fly\\.toml|vercel\\.json|netlify\\.toml)$", "^Caddyfile$", "^nginx.*\\.conf$", "^traefik",
            "^lefthook\\.ya?ml$", "^coolify"],
    words: ["deploy\\w*"],
    commands: ["^(?:kubectl|helm|terraform|tofu|ansible(?:-playbook)?|flyctl|fly|vercel|netlify|coolify)\\b",
               "^docker\\s+(?:push|login)\\b",
               `^${RUNNER}\\s+\\S*(?:deploy|release|publish)`,
               "^\\S*(?:deploy|release)[\\w.-]*\\.sh\\b"] },
  { name: "prod", to: "big",
    words: ["prod", "production"],
    commands: ["^(?:ssh|scp|sftp)\\b", "^rsync\\b.*\\s[\\w.@-]+:",
               "^\\S*(?:^|[/._-])(?:prod|production)(?:[/._-]|$)",
               `^${RUNNER}\\s+\\S*prod`] },
  { name: "module", to: "big", created: true,
    names: ["^(?:go\\.mod|package\\.json|Cargo\\.toml|pyproject\\.toml|Dockerfile|Containerfile)$"] },
  { name: "proto", to: "standard",
    paths: ["**/*.proto"], names: ["^buf(?:\\.gen|\\.work)?\\.ya?ml$"] },
  { name: "deps", to: "standard",
    names: ["^(?:package(?:-lock)?\\.json|bun\\.lockb?|pnpm-lock\\.yaml|yarn\\.lock|go\\.(?:mod|sum|work|work\\.sum)|Cargo\\.(?:toml|lock)|requirements[\\w.-]*\\.txt|pyproject\\.toml|poetry\\.lock|uv\\.lock|Gemfile(?:\\.lock)?|composer\\.(?:json|lock))$"] },
];

/** Paths exempt from the rules and the limits: docs, images, snapshots and generated code (its source
 *  — a `.proto`, a schema — carries the signal). */
const DEFAULT_IGNORE = [
  "**/*.md", "**/*.mdx", "docs/**", "**/*.snap", "**/__snapshots__/**", "**/*.png", "**/*.jpg", "**/*.jpeg",
  "**/*.gif", "**/*.webp", "**/*.ico", "**/*.svg", "**/gen/**", "**/generated/**", "**/*.pb.go", "**/*_pb.ts",
  "**/*_pb.js", "**/*_pb2.py", "**/*.gen.ts", "**/*.gen.go",
];

export const DEFAULT_SIZES_CFG: SizesCfg = {
  enabled: true,
  default: "big",
  side: { "read-only": "quick", ops: "quick", test: "quick", code: "standard" },
  override: { quick: ["/quick", "quick fix", "إصلاح سريع"], big: ["/full"] },
  quick: { maxFiles: 5, maxLines: 200, maxServices: 1, resultMaxLines: 3, noNewFiles: ["**/adr/**"] },
  standard: { maxFiles: 20, maxLines: 1000, maxServices: 3 },
  guard: { rules: DEFAULT_RULES, serviceMarkers: ["Dockerfile", "Containerfile"], ignore: DEFAULT_IGNORE },
  attention: {},
  projects: {},
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
const limit = (v: unknown, d: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : d);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);

/** Each regex source compiles case-insensitively. */
function regexesOk(list: string[]): boolean {
  try {
    for (const p of list) new RegExp(p, "i");
    return true;
  } catch {
    return false;
  }
}

/** One rule, or undefined when any field is badly typed or any regex is invalid. */
function readRule(raw: unknown): SizeRule | undefined {
  const r = obj(raw);
  if (typeof r.name !== "string" || !r.name.trim() || !isOrderSize(r.to)) return undefined;
  const rule: SizeRule = { name: r.name, to: r.to };
  for (const k of ["paths", "names", "words", "commands", "except"] as const) {
    if (r[k] === undefined) continue;
    if (!strings(r[k])) return undefined;
    if ((k === "names" || k === "words" || k === "commands") && !regexesOk(r[k] as string[])) return undefined;
    rule[k] = r[k] as string[];
  }
  if (r.created !== undefined) {
    if (typeof r.created !== "boolean") return undefined;
    rule.created = r.created;
  }
  return rule;
}

/** A rule list, else undefined (one bad entry rejects the whole list, as `plans.approval.patterns`). */
function readRules(v: unknown): SizeRule[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SizeRule[] = [];
  for (const raw of v) {
    const rule = readRule(raw);
    if (!rule) return undefined;
    out.push(rule);
  }
  return out;
}

/** Parse the config value (spec §10); a missing or badly typed field keeps its default. */
export function readSizesCfg(raw: unknown): SizesCfg {
  const r = obj(raw);
  const d = DEFAULT_SIZES_CFG;
  const side = obj(r.side), override = obj(r.override), quick = obj(r.quick), standard = obj(r.standard), guard = obj(r.guard);
  const sideOf = (k: LaneKind): OrderSize => (isOrderSize(side[k]) ? side[k] : d.side[k]);
  const attention: Record<string, OrderSize> = {};
  for (const [kind, size] of Object.entries(obj(r.attention))) if (isOrderSize(size)) attention[kind] = size;
  const projects: SizesCfg["projects"] = {};
  for (const [name, p] of Object.entries(obj(r.projects))) {
    const o = obj(p);
    projects[name] = { rules: readRules(o.rules) ?? [], except: strings(o.except) ? o.except : [] };
  }
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    default: isOrderSize(r.default) ? r.default : d.default,
    side: { "read-only": sideOf("read-only"), ops: sideOf("ops"), test: sideOf("test"), code: sideOf("code") },
    override: {
      quick: strings(override.quick) ? override.quick : d.override.quick,
      big: strings(override.big) ? override.big : d.override.big,
    },
    quick: {
      maxFiles: limit(quick.maxFiles, d.quick.maxFiles),
      maxLines: limit(quick.maxLines, d.quick.maxLines),
      maxServices: limit(quick.maxServices, d.quick.maxServices),
      resultMaxLines: limit(quick.resultMaxLines, d.quick.resultMaxLines),
      noNewFiles: strings(quick.noNewFiles) ? quick.noNewFiles : d.quick.noNewFiles,
    },
    standard: {
      maxFiles: limit(standard.maxFiles, d.standard.maxFiles),
      maxLines: limit(standard.maxLines, d.standard.maxLines),
      maxServices: limit(standard.maxServices, d.standard.maxServices),
    },
    guard: {
      rules: readRules(guard.rules) ?? d.guard.rules,
      serviceMarkers: strings(guard.serviceMarkers) && guard.serviceMarkers.length > 0 ? guard.serviceMarkers : d.guard.serviceMarkers,
      ignore: strings(guard.ignore) ? guard.ignore : d.guard.ignore,
    },
    attention,
    projects,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The operator's size override (spec §2.3): the message STARTS with a configured phrase. A `/command`
 *  phrase may carry a bot name (`/quick@neo_bot`) and ends at a space or the end; a word phrase is
 *  case-insensitive and is followed by a space, `:`, `,`, `-`, `—` or the end. Anywhere else in the
 *  text it is not an override. `rest` is the order without the phrase. */
export function parseSizeOverride(text: string, cfg: SizesCfg): { size: OrderSize; rest: string } | undefined {
  const t = text.trimStart();
  const phrases: Array<{ phrase: string; size: OrderSize }> = [
    ...cfg.override.quick.map((phrase) => ({ phrase, size: "quick" as const })),
    ...cfg.override.big.map((phrase) => ({ phrase, size: "big" as const })),
  ].sort((a, b) => b.phrase.length - a.phrase.length);
  for (const { phrase, size } of phrases) {
    const head = phrase.startsWith("/") ? `${escapeRe(phrase)}(?:@\\w+)?(?=\\s|$)` : `${escapeRe(phrase)}(?=[\\s:,\\-—]|$)`;
    const m = new RegExp(`^${head}[\\s:,\\-—]*`, "iu").exec(t);
    if (m) return { size, rest: t.slice(m[0].length).trim() };
  }
  return undefined;
}

/** What `resolveSize` weighs (spec §2). */
export interface SizeInput {
  /** The chief of staff's `size`. */
  chosen?: OrderSize;
  /** The operator's (parseSizeOverride). */
  override?: OrderSize;
  /** An engine rule (Execute, merge, attention kind). */
  engine?: OrderSize;
  /** A side brief's kind. */
  side?: LaneKind;
  /** An order that is always big: customer-driven, a Codex worker (no governor hook, so no guard), a team. */
  forced?: "customer" | "codex" | "team";
}

/** Why a size was set, as the replies name it (spec §4). */
export const SIZE_WHY = {
  off: "sizes are off",
  customer: "a customer-driven run is always big",
  codex: "the worker SDK is Codex: a smaller size needs the governor hook",
  team: "a team order is always big",
  override: "the operator's override",
  chosen: "the chief of staff's choice",
  engine: "an engine rule",
  side: (kind: LaneKind) => `the default for a ${kind} side brief`,
  default: "default: no size was given",
} as const;

/** The size of a new todo, decided once (spec §2). First match wins: sizes off → forced big →
 *  the operator's override → the chief of staff's size → an engine rule → a side brief's kind → the default. */
export function resolveSize(i: SizeInput, cfg: SizesCfg): { size: OrderSize; by: SizeBy; why?: string } {
  if (!cfg.enabled) return { size: "big", by: "engine", why: SIZE_WHY.off };
  if (i.forced) return { size: "big", by: "engine", why: SIZE_WHY[i.forced] };
  if (i.override) return { size: i.override, by: "operator", why: SIZE_WHY.override };
  if (i.chosen) return { size: i.chosen, by: "company", why: SIZE_WHY.chosen };
  if (i.engine) return { size: i.engine, by: "engine", why: SIZE_WHY.engine };
  if (i.side) return { size: cfg.side[i.side], by: "engine", why: SIZE_WHY.side(i.side) };
  return { size: cfg.default, by: "engine", why: SIZE_WHY.default };
}

// ── The upgrade guard's judge (spec §5.2–§5.3) ─────────────────────────────────────────────────────────────

/** What one tool call changes or runs; the guard builds it from the call's input (spec §5.1). */
export interface Touch {
  /** Folder-relative. `service` is `serviceOf(path)`, set by the guard (none = shared code). */
  paths: Array<{ path: string; lines: number; created: boolean; service?: string }>;
  /** The head (first 4 words) of each simple shell command. */
  commands: string[];
  /** A git commit point (§5.3): the guard measures the run's change with git first. */
  commit: boolean;
  /** An Agent/Task call with subagent_type "planner". */
  planner: boolean;
}

/** The run's counted change so far: each file's changed lines, and the services touched. */
export interface ChangeSoFar {
  files: ReadonlyMap<string, number>;
  services: ReadonlySet<string>;
}

export type SizeJudgement =
  | { kind: "ok" }
  | { kind: "deny"; why: "planner" | "just-fix" }
  | { kind: "up"; to: OrderSize; up: Omit<SizeUp, "from" | "to" | "at"> };

interface CompiledRule {
  name: string;
  to: OrderSize;
  paths: Bun.Glob[];
  names?: RegExp;
  words?: RegExp;
  commands?: RegExp;
  created: boolean;
  except: Bun.Glob[];
}

/** One run's rules, compiled once (compileSizeRules). The service lookups are cached here, for the run. */
export interface SizeRules {
  rules: CompiledRule[];
  /** `sizes.guard.ignore` and the project's `except`: no rule and no limit counts these paths. */
  ignore: Bun.Glob[];
  /** The plan paths and `sizes.quick.noNewFiles`: a quick order creates no file there. */
  noNewFiles: Bun.Glob[];
  limits: { quick: SizeLimits; standard: SizeLimits };
  serviceMarkers: string[];
  /** folder → holds a service marker. */
  serviceCache: Map<string, boolean>;
}

const anyOf = (list: string[] | undefined, wrap = (s: string) => s): RegExp | undefined =>
  list?.length ? new RegExp(list.map((p) => `(?:${wrap(p)})`).join("|"), "i") : undefined;
const globs = (list: string[] | undefined): Bun.Glob[] => (list ?? []).map((g) => new Bun.Glob(g));

/** The rules of one run in `project`: the config's rules then the project's own, every regex compiled once
 *  with the `i` flag; `words` are anchored to one whole path word. */
export function compileSizeRules(cfg: SizesCfg, project: string, planPaths: string[]): SizeRules {
  const own = cfg.projects[project];
  return {
    rules: [...cfg.guard.rules, ...(own?.rules ?? [])].map((r) => ({
      name: r.name,
      to: r.to,
      paths: globs(r.paths),
      names: anyOf(r.names),
      words: anyOf(r.words, (w) => `^(?:${w})$`),
      commands: anyOf(r.commands),
      created: r.created === true,
      except: globs(r.except),
    })),
    ignore: globs([...cfg.guard.ignore, ...(own?.except ?? [])]),
    noNewFiles: globs([...planPaths, ...cfg.quick.noNewFiles]),
    limits: { quick: cfg.quick, standard: cfg.standard },
    serviceMarkers: cfg.guard.serviceMarkers,
    serviceCache: new Map(),
  };
}

/** A path's words, lower case: split at every non-alphanumeric character and at camelCase boundaries
 *  (`HTTPServer` → `http server`), never at digits (`oauth2`, `2fa`). */
export function pathWords(path: string): string[] {
  return path
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** The service a path belongs to: the nearest folder strictly below the root that holds one of
 *  `sizes.guard.serviceMarkers`. None → shared code. */
export function serviceOf(path: string, rules: SizeRules, hasFile: (relPath: string) => boolean): string | undefined {
  const parts = path.split("/").slice(0, -1);
  for (let n = parts.length; n >= 1; n--) {
    const dir = parts.slice(0, n).join("/");
    let marked = rules.serviceCache.get(dir);
    if (marked === undefined) {
      marked = rules.serviceMarkers.some((m) => hasFile(`${dir}/${m}`));
      rules.serviceCache.set(dir, marked);
    }
    if (marked) return dir;
  }
  return undefined;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const rank = (s: OrderSize) => ORDER_SIZES.indexOf(s);

function pathHits(r: CompiledRule, p: Touch["paths"][number]): boolean {
  if (r.created && !p.created) return false;
  if (r.except.some((g) => g.match(p.path))) return false;
  return (
    r.paths.some((g) => g.match(p.path)) ||
    (r.names?.test(basename(p.path)) ?? false) ||
    (r.words !== undefined && pathWords(p.path).some((w) => r.words!.test(w)))
  );
}

/** The first limit of `limits` that the totals pass, with its facts. */
function passed(limits: SizeLimits, files: number, lines: number, services: string[]): Omit<SizeUp, "from" | "to" | "at"> | undefined {
  if (files > limits.maxFiles) return { rule: "files", value: files, max: limits.maxFiles };
  if (lines > limits.maxLines) return { rule: "lines", value: lines, max: limits.maxLines };
  if (services.length > limits.maxServices) return { rule: "services", value: services.length, max: limits.maxServices, path: services.join(", ") };
  return undefined;
}

/** Judge one call against the order's size (spec §5.3): (1) the planner is denied in quick and standard;
 *  (2) a quick order creates no plan, spec or ADR file; (3) the rule hits → the largest `to`; (4) the
 *  limits → the smallest size whose limits hold the totals of `sofar` and `touch`; (5) the larger of the
 *  two, `up` when it is above `size`, with the facts of what decided (a rule hit wins a tie). Big has no
 *  move up. Pure: the caller keeps `sofar`. */
export function judgeTouch(size: OrderSize, sofar: ChangeSoFar, touch: Touch, rules: SizeRules): SizeJudgement {
  if (size === "big") return { kind: "ok" };
  if (touch.planner) return { kind: "deny", why: "planner" };
  if (size === "quick" && touch.paths.some((p) => p.created && rules.noNewFiles.some((g) => g.match(p.path)))) {
    return { kind: "deny", why: "just-fix" };
  }
  const counted = touch.paths.filter((p) => !rules.ignore.some((g) => g.match(p.path)));

  let hit: { to: OrderSize; up: Omit<SizeUp, "from" | "to" | "at"> } | undefined;
  const consider = (r: CompiledRule, fact: { path: string } | { command: string }) => {
    if (!hit || rank(r.to) > rank(hit.to)) hit = { to: r.to, up: { rule: r.name, ...fact } };
  };
  for (const p of counted) for (const r of rules.rules) if (pathHits(r, p)) consider(r, { path: p.path });
  for (const c of touch.commands) for (const r of rules.rules) if (r.commands?.test(c)) consider(r, { command: c });

  const files = new Map(sofar.files);
  for (const p of counted) files.set(p.path, (files.get(p.path) ?? 0) + p.lines);
  const services = new Set(sofar.services);
  for (const p of counted) if (p.service) services.add(p.service);
  let lines = 0;
  for (const n of files.values()) lines += n;
  const list = [...services].sort();
  const overQuick = passed(rules.limits.quick, files.size, lines, list);
  const overStandard = overQuick && passed(rules.limits.standard, files.size, lines, list);
  const limit = overStandard ? { to: "big" as const, up: overStandard } : overQuick ? { to: "standard" as const, up: overQuick } : undefined;

  const decided = hit && (!limit || rank(hit.to) >= rank(limit.to)) ? hit : limit;
  if (!decided || rank(decided.to) <= rank(size)) return { kind: "ok" };
  return { kind: "up", to: decided.to, up: decided.up };
}

// ── The texts (all English engine text; the console renders the facts through its catalogues) ──────────────

/** A todo's size badge: `[quick]`, or `[quick→big]` after a move up. */
export function sizeTag(t: { size: OrderSize; sizeUp?: SizeUp }): string {
  return t.sizeUp ? `[${t.sizeUp.from}→${t.size}]` : `[${t.size}]`;
}

/** Why an order moved up (spec §5.4 `{reason}`). A limit's `max` is the limit of the size below `to`. A
 *  services move carries the services in `path`; a plan move may carry the areas its plan touches there. */
export function sizeReason(up: SizeUp): string {
  const below = ORDER_SIZES[Math.max(0, rank(up.to) - 1)];
  switch (up.rule) {
    case "files":
    case "lines":
      return `it changes ${up.value} ${up.rule} (a ${below} order allows ${up.max})`;
    case "services":
      return `it changes ${up.value} services${up.path ? `: ${up.path}` : ""} (a ${below} order allows ${up.max})`;
    case "plan":
      return `its plan needs the operator's approval${up.path ? ` (touches: ${up.path})` : ""}`;
    case "handoff":
      return "it needed a context handoff";
    default:
      if (up.command) return `it runs ${up.rule} tooling: \`${up.command}\``;
      return `it touches ${up.rule}${up.path ? `: ${up.path}` : ""}`;
  }
}

const SENSITIVE = "auth, money, migrations, secrets, deploy/CI or prod";

/** The deny text of the call that moved the order up (spec §5.4). To standard: the run goes on under
 *  standard's limits (from the config). To big: the plan first. */
export function upSteer(up: SizeUp, cfg: SizesCfg): string {
  const from = up.from.toUpperCase();
  if (up.to === "standard") {
    const s = cfg.standard;
    return (
      `Not run: Neo moved this order up from ${from} to STANDARD — ${sizeReason(up)}. Run the call again. From now on: ` +
      "a short plan in your task list, test-first (a failing test for each behaviour you change), verify, commit in " +
      "checkpoints; an ADR only for a real decision; no planner and no plan file. Neo moves it up to BIG if it grows " +
      `past ${s.maxFiles} files, ${s.maxLines} lines or ${s.maxServices} services, or touches ${SENSITIVE}.`
    );
  }
  return (
    `STOP — Neo moved this order up from ${from} to BIG — ${sizeReason(up)}. This call was not run. A big order needs the ` +
    "operator's approval before more code changes: write the plan for the whole task (what changes, why, the risks, " +
    "the tests) at docs/superpowers/plans/<date>-<slug>.md — the `planner` subagent can write it — then end your turn " +
    "with a one-line summary. Neo sends it to the operator; Approve & build resumes you. Until then only reads, Neo's " +
    "tools, helper agents and Markdown files run. Leave the changes you made so far as they are."
  );
}

/** The deny text of every other call while a big order writes its plan first (spec §5.4). */
export function planFirstSteer(up: SizeUp): string {
  return (
    `STOP — this order is BIG now (${sizeReason(up)}). Write its plan first (docs/superpowers/plans/…; the \`planner\` ` +
    "subagent can help), then end your turn; the operator approves it before any more changes. Until then only reads, " +
    "Neo's tools, helper agents and Markdown files run."
  );
}

/** The deny text of a side lane moved to big (spec §5.4): a side lane has no plan gate, so it stops, and the
 *  todo joins the main queue as big. */
export function sideStopSteer(up: SizeUp): string {
  return (
    `STOP — Neo moved this side-lane order up from ${up.from.toUpperCase()} to BIG — ${sizeReason(up)}. This call was ` +
    "not run. A big order runs in the main lane, with a plan the operator approves: make no more changes, and end " +
    "your turn with a one-line summary of what you did. Neo moves the todo to the main queue as big. Until then only " +
    "reads run."
  );
}

/** The operator's one line about a move up (spec §5.4). */
export function operatorUpLine(p: { project: string; todoId?: number; up: SizeUp; side?: boolean }): string {
  const tail = p.up.late
    ? "found after the run ended"
    : p.side && p.up.to === "big"
      ? "the side lane stops; the todo joins the main queue as big"
      : p.up.to === "big"
        ? "it stops and writes a plan for your Approve & build"
        : "it goes on, test-first";
  const id = p.todoId !== undefined ? ` #${p.todoId}` : "";
  return `↑ ${p.project}${id} ${p.up.from} → ${p.up.to}: ${sizeReason(p.up)} — ${tail}`;
}

/** The deny texts without a move (spec §5.4). */
export function plannerDenyText(size: OrderSize): string {
  return size === "quick"
    ? "Not run: this is a QUICK order — no planner subagent. Just fix it: read the code, change it, check it, commit once. Neo moves the order up by itself if it grows."
    : "Not run: this is a STANDARD order — no planner subagent. Plan briefly in your task list and build test-first. Neo moves the order up by itself if it grows.";
}
export const JUST_FIX_TEXT =
  "Not run: quick task — just fix. A quick order writes no plan, spec or ADR file. If the fix cannot be done without one, say so in one line and end your turn; the chief of staff sends it again as a bigger order.";
export function measureFailedText(error: string, size: OrderSize): string {
  return `Not run: Neo could not measure this order's change (${error}), and a ${size} order commits only after its size is checked. Run the commit again; if this repeats, end your turn and say so.`;
}
export const GUARD_ERROR_TEXT =
  "Not run: Neo could not check this call against the order's size (an internal error, reported to the operator). Try once more; if it repeats, end your turn and say so.";

/** The `dispatch` tool's guide to the sizes (spec §4). */
export const SIZE_GUIDE =
  "Size (`size`) — how much process the worker runs; pick it while you write the brief. `quick`: one page or " +
  "screen, a small change, no data-model change (a date picker that does not clear, a wrong label) — the worker " +
  "just fixes it: no planner, spec, ADR or plan; one commit; a 2–3 line result. `standard`: a few files or " +
  "services (a list filter with its API) — a short plan in its task list, test-first, no approval gate. `big`: " +
  "new modules or services, migrations, auth, payment/money, prod or deploy, multi-service work — the full " +
  "flow; a big plan waits for the operator's Approve & build. Unsure: pick the larger. No size = `big`. The " +
  "operator's `/quick`, `/full` or \"quick fix\" overrides you. The engine moves an order UP a size when it " +
  "touches a sensitive area or grows, never down, and says so.";
