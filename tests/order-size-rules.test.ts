// ADR-0072: the upgrade guard's rules and limits as one pure judge (spec §5.2–§5.4, AC 7, 8 and 10, the pure
// parts), and the texts the guard and the replies use.
import { expect, test } from "bun:test";
import {
  DEFAULT_SIZES_CFG,
  SIZE_GUIDE,
  compileSizeRules,
  judgeTouch,
  operatorUpLine,
  pathWords,
  planFirstSteer,
  readSizesCfg,
  serviceOf,
  sideStopSteer,
  sizeReason,
  sizeTag,
  upSteer,
  type ChangeSoFar,
  type OrderSize,
  type SizeUp,
  type Touch,
} from "../src/engine/order-size";
import { DEFAULT_PLAN_PATHS } from "../src/engine/plans";

const RULES = compileSizeRules(DEFAULT_SIZES_CFG, "eticket-v3", DEFAULT_PLAN_PATHS);
const EMPTY: ChangeSoFar = { files: new Map(), services: new Set() };
const touch = (o: Partial<Touch> = {}): Touch => ({ paths: [], commands: [], commit: false, planner: false, ...o });
const onePath = (path: string, created = false, lines = 1, service?: string): Touch =>
  touch({ paths: [{ path, lines, created, ...(service ? { service } : {}) }] });
const oneCommand = (command: string): Touch => touch({ commands: [command] });
/** `n` distinct files of `lines` lines each, in `service`. */
const sofar = (n: number, lines = 1, services: string[] = []): ChangeSoFar => ({
  files: new Map(Array.from({ length: n }, (_, i) => [`src/f${i}.ts`, lines])),
  services: new Set(services),
});

test("pathWords splits at non-alphanumerics and camelCase, never at digits", () => {
  expect(pathWords("PaymentMethodPicker.tsx").join(" ")).toBe("payment method picker tsx");
  expect(pathWords("HTTPServer.go").join(" ")).toBe("http server go");
  expect(pathWords("oauth2/2fa.ts")).toEqual(["oauth2", "2fa", "ts"]);
  expect(pathWords("ui/agency-ui/src/components/booking/PaymentMethodPicker.tsx").join(" ")).toBe(
    "ui agency ui src components booking payment method picker tsx",
  );
});

// AC 7: [path or command, the rule that decides, the size it moves to].
const POSITIVE: Array<[string, string, OrderSize, "path" | "created" | "command"]> = [
  ["services/common/authcontext/x.go", "auth", "big", "path"],
  ["ui/admin-ui/src/components/users/RolePicker.jsx", "auth", "big", "path"],
  ["ui/agency-ui/src/components/booking/PaymentMethodPicker.tsx", "money", "big", "path"],
  [".env.local", "secrets", "big", "path"],
  ["services/x/.env.local", "secrets", "big", "path"],
  ["docker-compose.prod.yml", "deploy", "big", "path"],
  [".github/workflows/ci.yml", "deploy", "big", "path"],
  ["migrations/310_x.sql", "migration", "big", "path"],
  ["npx prisma migrate dev", "migration", "big", "command"],
  ["kubectl apply -f k8s", "deploy", "big", "command"],
  ["ssh prod-1", "prod", "big", "command"],
  ["services/x/go.mod", "module", "big", "created"],
  ["api/booking.proto", "proto", "standard", "path"],
  ["package.json", "deps", "standard", "path"],
];

test("AC 7: each sensitive path or command moves a quick and a standard order to its rule's size", () => {
  for (const [what, rule, to, kind] of POSITIVE) {
    const t = kind === "command" ? oneCommand(what) : onePath(what, kind === "created");
    for (const size of ["quick", "standard"] as const) {
      const j = judgeTouch(size, EMPTY, t, RULES);
      if (size === "standard" && to === "standard") {
        expect(j, `${what} from standard`).toEqual({ kind: "ok" });
        continue;
      }
      expect(j.kind, `${what} from ${size}`).toBe("up");
      if (j.kind !== "up") continue;
      expect(j.to).toBe(to);
      expect(j.up.rule).toBe(rule);
      if (kind === "command") expect(j.up.command).toBe(what);
      else expect(j.up.path).toBe(what);
    }
  }
});

test("AC 7: the negative cases stay quick", () => {
  for (const p of ["author.ts", "authority.go", "docs/adr/0001-auth.md", "src/pipeline.ts", "src/components/ui/date-picker.tsx", ".env.example"]) {
    expect(judgeTouch("quick", EMPTY, onePath(p), RULES), p).toEqual({ kind: "ok" });
  }
  for (const c of ["grep -r prod src", "cat migrations/001.sql"]) {
    expect(judgeTouch("quick", EMPTY, oneCommand(c), RULES), c).toEqual({ kind: "ok" });
  }
  // An existing go.mod is a dependency change, not a new module.
  const goMod = judgeTouch("quick", EMPTY, onePath("services/x/go.mod"), RULES);
  expect(goMod.kind === "up" && goMod.to).toBe("standard");
});

test("AC 8: the quick limits move an order to standard, with the facts", () => {
  const files = judgeTouch("quick", sofar(5), onePath("src/g.ts"), RULES);
  expect(files).toEqual({ kind: "up", to: "standard", up: { rule: "files", value: 6, max: 5 } });
  const lines = judgeTouch("quick", sofar(1, 200), onePath("src/f0.ts", false, 1), RULES);
  expect(lines).toEqual({ kind: "up", to: "standard", up: { rule: "lines", value: 201, max: 200 } });
  const services = judgeTouch("quick", sofar(1, 1, ["services/a"]), onePath("services/b/x.go", false, 1, "services/b"), RULES);
  expect(services).toEqual({ kind: "up", to: "standard", up: { rule: "services", value: 2, max: 1, path: "services/a, services/b" } });
  // At the limits: still quick.
  expect(judgeTouch("quick", sofar(4), onePath("src/g.ts"), RULES)).toEqual({ kind: "ok" });
  expect(judgeTouch("quick", sofar(1, 199), onePath("src/f0.ts"), RULES)).toEqual({ kind: "ok" });
  expect(judgeTouch("quick", sofar(1, 1, ["services/a"]), onePath("services/a/y.go", false, 1, "services/a"), RULES)).toEqual({ kind: "ok" });
});

test("AC 8: the standard limits move an order to big; a quick touch past them goes straight to big", () => {
  expect(judgeTouch("standard", sofar(20), onePath("src/g.ts"), RULES)).toEqual({ kind: "up", to: "big", up: { rule: "files", value: 21, max: 20 } });
  expect(judgeTouch("standard", sofar(1, 1000), onePath("src/f0.ts"), RULES)).toEqual({ kind: "up", to: "big", up: { rule: "lines", value: 1001, max: 1000 } });
  const s = judgeTouch("standard", sofar(3, 1, ["a", "b", "c"]), onePath("d/x.go", false, 1, "d"), RULES);
  expect(s).toEqual({ kind: "up", to: "big", up: { rule: "services", value: 4, max: 3, path: "a, b, c, d" } });
  expect(judgeTouch("standard", sofar(19), onePath("src/g.ts"), RULES)).toEqual({ kind: "ok" });
  expect(judgeTouch("quick", sofar(20), onePath("src/g.ts"), RULES)).toEqual({ kind: "up", to: "big", up: { rule: "files", value: 21, max: 20 } });
});

test("AC 8: ignored paths add nothing; a rule hit wins a tie with a limit", () => {
  expect(judgeTouch("quick", sofar(5), onePath("docs/guide.md", false, 500), RULES)).toEqual({ kind: "ok" });
  expect(judgeTouch("quick", sofar(5), onePath("src/__snapshots__/a.snap", true, 500), RULES)).toEqual({ kind: "ok" });
  const tie = judgeTouch("quick", sofar(5), onePath("package.json"), RULES);
  expect(tie).toEqual({ kind: "up", to: "standard", up: { rule: "deps", path: "package.json" } });
  // A limit above the rule decides.
  const over = judgeTouch("quick", sofar(20), onePath("package.json"), RULES);
  expect(over).toEqual({ kind: "up", to: "big", up: { rule: "files", value: 21, max: 20 } });
});

test("AC 10: the planner is denied in quick and standard, allowed in big", () => {
  const t = touch({ planner: true });
  expect(judgeTouch("quick", EMPTY, t, RULES)).toEqual({ kind: "deny", why: "planner" });
  expect(judgeTouch("standard", EMPTY, t, RULES)).toEqual({ kind: "deny", why: "planner" });
  expect(judgeTouch("big", EMPTY, t, RULES)).toEqual({ kind: "ok" });
});

test("AC 10: a new plan, spec or ADR file in quick is denied as just-fix; an edit of one is not", () => {
  for (const p of ["docs/superpowers/plans/2026-10-31-x.md", "docs/superpowers/specs/x.md", "docs/adr/0099-x.md", "services/a/adr/1.md"]) {
    expect(judgeTouch("quick", EMPTY, onePath(p, true), RULES), p).toEqual({ kind: "deny", why: "just-fix" });
    expect(judgeTouch("quick", EMPTY, onePath(p, false), RULES), p).toEqual({ kind: "ok" });
    expect(judgeTouch("standard", EMPTY, onePath(p, true), RULES), p).toEqual({ kind: "ok" });
  }
});

test("a big order has no move up", () => {
  expect(judgeTouch("big", sofar(500, 50), onePath(".github/workflows/x.yml", true), RULES)).toEqual({ kind: "ok" });
});

test("a project's own rules and exemptions apply to that project only", () => {
  const cfg = readSizesCfg({
    projects: { gold: { rules: [{ name: "ledger", to: "big", words: ["ledger"] }], except: ["legacy/**"] } },
  });
  const gold = compileSizeRules(cfg, "gold", DEFAULT_PLAN_PATHS);
  const other = compileSizeRules(cfg, "neo", DEFAULT_PLAN_PATHS);
  const hit = judgeTouch("quick", EMPTY, onePath("src/ledger.ts"), gold);
  expect(hit).toEqual({ kind: "up", to: "big", up: { rule: "ledger", path: "src/ledger.ts" } });
  expect(judgeTouch("quick", EMPTY, onePath("src/ledger.ts"), other)).toEqual({ kind: "ok" });
  expect(judgeTouch("quick", EMPTY, onePath("legacy/payment.ts"), gold)).toEqual({ kind: "ok" });
  expect(judgeTouch("quick", EMPTY, onePath("legacy/payment.ts"), other).kind).toBe("up");
});

test("a rule's `except` exempts a path from that rule", () => {
  const rules = DEFAULT_SIZES_CFG.guard.rules.map((r) => (r.name === "money" ? { ...r, except: ["src/i18n/**"] } : r));
  const cfg = { ...DEFAULT_SIZES_CFG, guard: { ...DEFAULT_SIZES_CFG.guard, rules } };
  const compiled = compileSizeRules(cfg, "x", DEFAULT_PLAN_PATHS);
  expect(judgeTouch("quick", EMPTY, onePath("src/i18n/prices.ts"), compiled)).toEqual({ kind: "ok" });
  expect(judgeTouch("quick", EMPTY, onePath("src/prices.ts"), compiled).kind).toBe("up");
});

test("serviceOf: the nearest folder below the root with a marker; shared code has none", () => {
  const files = new Set(["services/core-service/Dockerfile", "ui/agency-ui/Containerfile", "Dockerfile"]);
  const asked: string[] = [];
  const has = (p: string) => (asked.push(p), files.has(p));
  const rules = compileSizeRules(DEFAULT_SIZES_CFG, "eticket-v3", DEFAULT_PLAN_PATHS);
  expect(serviceOf("services/core-service/internal/x/y.go", rules, has)).toBe("services/core-service");
  expect(serviceOf("ui/agency-ui/src/a.tsx", rules, has)).toBe("ui/agency-ui");
  expect(serviceOf("packages/i18n/en.json", rules, has)).toBeUndefined();
  expect(serviceOf("README.ts", rules, has)).toBeUndefined(); // the root is no service
  const before = asked.length;
  serviceOf("services/core-service/internal/x/z.go", rules, has);
  expect(asked.length).toBe(before); // cached for the run
});

const up = (o: Partial<SizeUp>): SizeUp => ({ from: "quick", to: "big", rule: "auth", at: 1, ...o });

test("sizeTag names the size and a move up", () => {
  expect(sizeTag({ size: "quick" })).toBe("[quick]");
  expect(sizeTag({ size: "big", sizeUp: up({}) })).toBe("[quick→big]");
});

test("sizeReason for each rule kind", () => {
  expect(sizeReason(up({ to: "standard", rule: "files", value: 6, max: 5 }))).toBe("it changes 6 files (a quick order allows 5)");
  expect(sizeReason(up({ to: "standard", rule: "lines", value: 240, max: 200 }))).toBe("it changes 240 lines (a quick order allows 200)");
  expect(sizeReason(up({ to: "standard", rule: "services", value: 2, max: 1, path: "services/core-service, ui/agency-ui" }))).toBe(
    "it changes 2 services: services/core-service, ui/agency-ui (a quick order allows 1)",
  );
  expect(sizeReason(up({ rule: "files", value: 21, max: 20 }))).toBe("it changes 21 files (a standard order allows 20)");
  expect(sizeReason(up({ path: "services/identity-service/auth/token.go" }))).toBe("it touches auth: services/identity-service/auth/token.go");
  expect(sizeReason(up({ rule: "deploy", command: "kubectl apply -f k8s" }))).toBe("it runs deploy tooling: `kubectl apply -f k8s`");
  expect(sizeReason(up({ rule: "plan", path: "migration" }))).toBe("its plan needs the operator's approval (touches: migration)");
  expect(sizeReason(up({ rule: "plan" }))).toBe("its plan needs the operator's approval");
  expect(sizeReason(up({ to: "standard", rule: "handoff" }))).toBe("it needed a context handoff");
});

test("upSteer: to standard names standard's limits from the config; to big asks for the plan first", () => {
  const std = upSteer(up({ to: "standard", rule: "files", value: 6, max: 5 }), DEFAULT_SIZES_CFG);
  expect(std).toStartWith("Not run: Neo moved this order up from QUICK to STANDARD — it changes 6 files (a quick order allows 5).");
  expect(std).toContain("past 20 files, 1000 lines or 3 services");
  const cfg = readSizesCfg({ standard: { maxFiles: 12, maxLines: 600, maxServices: 2 } });
  expect(upSteer(up({ to: "standard", rule: "files", value: 6, max: 5 }), cfg)).toContain("past 12 files, 600 lines or 2 services");
  const big = upSteer(up({ path: "services/identity-service/auth/token.go" }), DEFAULT_SIZES_CFG);
  expect(big).toStartWith("STOP — Neo moved this order up from QUICK to BIG — it touches auth: services/identity-service/auth/token.go. This call was not run.");
  expect(big).toContain("Approve & build resumes you");
  expect(planFirstSteer(up({ path: "a/auth.ts" }))).toStartWith("STOP — this order is BIG now (it touches auth: a/auth.ts). Write its plan first");
  expect(sideStopSteer(up({ path: "a/auth.ts" }))).toContain("it touches auth: a/auth.ts");
});

test("operatorUpLine: one line with the project, the todo, the move and what happens next", () => {
  const u = up({ path: "services/identity-service/auth/token.go" });
  expect(operatorUpLine({ project: "eticket-v3", todoId: 812, up: u })).toBe(
    "↑ eticket-v3 #812 quick → big: it touches auth: services/identity-service/auth/token.go — it stops and writes a plan for your Approve & build",
  );
  expect(operatorUpLine({ project: "p", up: up({ to: "standard", rule: "files", value: 6, max: 5 }) })).toBe(
    "↑ p quick → standard: it changes 6 files (a quick order allows 5) — it goes on, test-first",
  );
  expect(operatorUpLine({ project: "p", todoId: 1, up: u, side: true })).toEndWith("— the side lane stops; the todo joins the main queue as big");
  expect(operatorUpLine({ project: "p", todoId: 1, up: { ...u, late: true } })).toEndWith("— found after the run ended");
});

test("SIZE_GUIDE tells the chief of staff the three sizes and that big is the default", () => {
  for (const s of ["`quick`", "`standard`", "`big`", "No size = `big`", "`/quick`", "never down"]) expect(SIZE_GUIDE).toContain(s);
});

// ── Review fixes (ADR-0072 as built): rule gaps, and secrets/deploy before the ignore list ─────────────────────

test("review: secrets, auth tokens, crypto and data-model paths move an order to big", () => {
  const cases: Array<[string, string]> = [
    [".envrc", "secrets"],
    ["services/api/.envrc", "secrets"],
    [".dev.vars", "secrets"],
    ["workers/mail/.dev.vars", "secrets"],
    ["config/service-account.json", "secrets"],
    ["deploy-keys/service_account-prod.json", "secrets"],
    ["src/lib/crypto.ts", "secrets"],
    ["src/util/encryption.go", "secrets"],
    ["pkg/hmac/sign.go", "secrets"],
    ["src/lib/refreshToken.ts", "auth"],
    ["src/api/access-tokens.ts", "auth"],
    ["services/core/ent/schema/booking.go", "migration"],
    ["db/schema.sql", "migration"],
    ["prisma/models/booking.prisma", "migration"],
  ];
  for (const [p, rule] of cases) {
    const j = judgeTouch("quick", EMPTY, onePath(p), RULES);
    expect(j.kind === "up" ? [j.to, j.up.rule] : j.kind, p).toEqual(["big", rule]);
  }
});

test("review: tokens and crypto are word-anchored; design tokens, a lexer's tokens and cryptic names stay quick", () => {
  for (const p of [
    "src/theme/tokens.ts",
    "packages/ui/src/design-tokens.ts",
    "styles/tokens.scss",
    "src/lexer/token.go",
    "src/parser/tokens.ts",
    "src/tokenizer.ts",
    "src/cryptic-label.tsx",
    "src/components/KeyboardShortcuts.tsx",
    "docs/secrets-howto.txt.md",
  ]) {
    expect(judgeTouch("quick", EMPTY, onePath(p), RULES), p).toEqual({ kind: "ok" });
  }
});

test("review: package-runner, container and psql forms of a schema change move an order to big", () => {
  for (const c of [
    "pnpm prisma migrate dev",
    "pnpm exec prisma migrate",
    "npx -y prisma migrate",
    "bunx --bun prisma migrate",
    "yarn prisma migrate deploy",
    "bunx prisma db push",
    "npx drizzle-kit push",
    "psql -c ALTER TABLE users ADD COLUMN x int",
    "psql -c create table t (id int)",
    "psql -c DROP TABLE t",
  ]) {
    const j = judgeTouch("quick", EMPTY, oneCommand(c), RULES);
    expect(j.kind === "up" ? [j.to, j.up.rule] : j.kind, c).toEqual(["big", "migration"]);
  }
  for (const c of ["psql -c SELECT * FROM users", "pnpm prisma generate", "bunx prisma studio"]) {
    expect(judgeTouch("quick", EMPTY, oneCommand(c), RULES), c).toEqual({ kind: "ok" });
  }
});

test("review: secrets and deploy are checked before the ignore list; a document stays a document", () => {
  for (const [p, rule] of [
    ["docs/.env.production", "secrets"],
    ["generated/certs/server.pem", "secrets"],
    ["docs/examples/docker-compose.yml", "deploy"],
    ["gen/k8s/deployment.yaml", "deploy"],
  ] as const) {
    const j = judgeTouch("quick", EMPTY, onePath(p), RULES);
    expect(j.kind === "up" ? [j.to, j.up.rule] : j.kind, p).toEqual(["big", rule]);
  }
  // Docs about the topic are not the thing itself; other rules still skip ignored paths.
  for (const p of ["docs/deploy/runbook.md", "docs/secrets.md", ".github/pull_request_template.md", "docs/auth/login-flow.md", "docs/payments.txt"]) {
    expect(judgeTouch("quick", EMPTY, onePath(p), RULES), p).toEqual({ kind: "ok" });
  }
  // An ignored path still counts toward no limit.
  expect(judgeTouch("quick", sofar(5), onePath("docs/.env.production", true, 0), RULES)).toMatchObject({ kind: "up", to: "big", up: { rule: "secrets" } });
});

test("review: a rule's `always` reads from the config; a bad type rejects the list", () => {
  const ok = readSizesCfg({ guard: { rules: [{ name: "x", to: "big", names: ["^x$"], always: true }] } });
  expect(ok.guard.rules[0]).toEqual({ name: "x", to: "big", names: ["^x$"], always: true });
  const bad = readSizesCfg({ guard: { rules: [{ name: "x", to: "big", names: ["^x$"], always: "yes" }] } });
  expect(bad.guard.rules).toBe(DEFAULT_SIZES_CFG.guard.rules);
});
