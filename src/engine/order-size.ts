// Order sizes (ADR-0072): an order is `quick`, `standard` or `big`. The chief of staff sets the size, the
// operator's own message overrides it, and the upgrade guard only moves it up. This module is the size
// model — the sizes, the `sizes` config, the operator's override and `resolveSize`. Pure: no I/O, no ledger.
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
