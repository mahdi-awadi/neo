# Order sizes — quick, standard, big — design spec (ADR-0072)

**Operator order (2026-10-31, top priority):** "order SIZES, so small fixes stop going through the full plan
machinery". A one-page fix today costs an hour of documents. Required: three sizes; the chief of staff sets the
size and the operator overrides it; a preamble per size; a deterministic upgrade guard that fails closed; a plan
gate that never holds a quick order; the company's rules; a size badge; short quick results. Safety never
relaxes at any size.

ADR: `docs/adr/0072-an-order-has-a-size-and-the-engine-only-moves-it-up.md` · Plan:
`docs/superpowers/plans/2026-10-31-order-sizes.md` · Terms: `CONTEXT.md` ("Order sizes").

## 1. The three sizes

| | `quick` | `standard` | `big` |
|---|---|---|---|
| Fits | one page or screen, a small change, no data-model change | a few files or services | new modules, migrations, auth, payment/money, prod, multi-service |
| Preamble | the quick variant (§7) | the standard variant (§7) | today's `briefWithProjectDocs`, unchanged |
| Design | none: read the code and fix it | a short plan in the worker's own task list (TodoWrite); an ADR only for a real decision | planner, CONTEXT.md, ADRs, spec, plan |
| Tests | only when logic changes | test-first for each behaviour changed | TDD for each acceptance criterion |
| Planner subagent | denied in code | denied in code | offered (ADR-0063) |
| New plan, spec or ADR file | denied in code: "quick task: just fix" | allowed (an `info` card; a held plan moves the order to big) | the full flow |
| Plan gate (ADR-0036) | never holds | as today | as today |
| Upgrade guard | to standard past 5 files, 200 lines or 1 service; to big on a sensitive rule, or past standard's limits | to big past 20 files, 1000 lines or 3 services, or on a sensitive rule | none (top size); the change is measured at the end for the record |
| Commits | one | in checkpoints | in checkpoints |
| Result | 2–3 lines; the operator's notification is clamped to 3 lines | short | as today |

Push rule, security hooks, project fence, governor, "numbers stay LTR", AR+EN: the same at every size.

## 2. Who sets the size

`resolveSize` decides once, when the todo is made. Its precedence, first match wins:

1. `sizes.enabled: false` → `big` (by `engine`: "sizes are off").
2. Forced `big` (by `engine`, with the reason): a customer-driven company run (`replyChat === CUSTOMER_CHAT`);
   the worker SDK is Codex (no governor hook, so no guard); a team order (`team: "frontend-backend"`).
3. The operator's **size override** (by `operator`). The engine reads it in code from the operator's own message:
   first the live message that the company answers now, then the root of the thread that the work is filed
   under. Each is used only when it is `role: "user"` and `surface` is `telegram` or `web` (the same check as
   the `plan` and `decision` tools). `parseSizeOverride`: the message starts with `/quick` (also
   `/quick@<bot>`) → `quick`; with `/full` → `big`; with a configured phrase (`"quick fix"`, `"إصلاح سريع"`;
   case-insensitive, followed by space, `:`, `,`, `-` or `—`) → `quick`. Anywhere else in the text it is not an
   override.
4. The chief of staff's `size` argument (by `company`).
5. An engine rule (by `engine`): an Execute (ADR-0034) and a side-lane merge todo → `big`; an attention todo →
   its kind's size (§9).
6. A side brief with no size → `sizes.side[kind]` (`read-only`, `ops`, `test` → `quick`; `code` → `standard`).
7. `sizes.default` → `big`.

After resolving: a `big` side brief runs in the main lane (a big order needs the plan gate, which side lanes do
not have). The reply says so.

Retries keep the row's size. A continuation keeps its todo's size, except that a quick one becomes `standard`
with a size up (rule `handoff`). A side continuation (an answered side question) keeps the size.

**Why `big` is the default.** "No size" means that nobody judged the work. The guard can only move a size up, so
an unjudged order must start at today's safety. A wrong big costs time; a wrong small costs safety. The speed
comes from the chief of staff, which sizes every order it writes, and from the operator's `/quick`. Same shape
as ADR-0036 ("never small") and ADR-0057 (no lane = the queue).

**Paths that do not use sizes.** Loops keep `loopBrief` (ADR-0063): their standing prompt is their own contract,
and they cannot ask the operator or wait at a plan gate. Consult runs are read-only. Tainted customer briefs run
with zero tools. Operator-opened sessions (`/open`, a focused chat) are the operator's own conversation. A todo
delivered into an operator-opened session (ADR-0008) is done at once, with no guard.

## 3. The seams and their interfaces

One pure model, one stateful adapter for each run, and small hooks on the existing seams. Nothing else learns
the rules.

```ts
// src/engine/order-size.ts — the size model. Pure: no I/O, no ledger.
export const ORDER_SIZES = ["quick", "standard", "big"] as const;
export type OrderSize = (typeof ORDER_SIZES)[number];
export type SizeBy = "operator" | "company" | "engine";
export function isOrderSize(x: unknown): x is OrderSize;
export function larger(a: OrderSize, b: OrderSize): OrderSize;

export const DEFAULT_SIZES_CFG: SizesCfg;
export function readSizesCfg(raw: unknown): SizesCfg;                       // §10
export function parseSizeOverride(text: string, cfg: SizesCfg): { size: OrderSize; rest: string } | undefined;
export interface SizeInput {
  chosen?: OrderSize;            // the chief of staff's `size`
  override?: OrderSize;          // the operator's (parseSizeOverride)
  engine?: OrderSize;            // an engine rule (Execute, merge, attention kind)
  side?: LaneKind;               // a side brief's kind
  forced?: "customer" | "codex" | "team";
}
export function resolveSize(i: SizeInput, cfg: SizesCfg): { size: OrderSize; by: SizeBy; why?: string };

/** One move up. `from` is the size the order started at (kept across two moves). */
export interface SizeUp {
  from: OrderSize; to: OrderSize;
  rule: string;                  // "files" | "lines" | "services" | "plan" | "handoff" | a rule name (§5.2)
  path?: string; command?: string; value?: number; max?: number; late?: boolean; at: number;
}
/** What one tool call changes or runs; the guard builds it from the call's input. */
export interface Touch {
  paths: Array<{ path: string; lines: number; created: boolean }>;   // folder-relative
  commands: string[];            // the head (first 4 words) of each simple shell command
  commit: boolean;               // a git commit point (§5.3)
  planner: boolean;              // an Agent/Task call with subagent_type "planner"
}
export interface ChangeSoFar { files: ReadonlyMap<string, number>; services: ReadonlySet<string> }
export type SizeJudgement =
  | { kind: "ok" }
  | { kind: "deny"; why: "planner" | "just-fix" }
  | { kind: "up"; to: OrderSize; up: Omit<SizeUp, "from" | "to" | "at"> };
export function compileSizeRules(cfg: SizesCfg, project: string, planPaths: string[]): SizeRules;
export function pathWords(path: string): string[];
export function serviceOf(path: string, rules: SizeRules, hasFile: (relPath: string) => boolean): string | undefined;
export function judgeTouch(size: OrderSize, sofar: ChangeSoFar, touch: Touch, rules: SizeRules): SizeJudgement;

// Texts (all English engine text; the console renders the facts through its catalogues).
export function sizeTag(t: { size: OrderSize; sizeUp?: SizeUp }): string;   // "[quick]", "[quick→big]"
export function sizeReason(up: SizeUp): string;
export function upSteer(up: SizeUp, cfg: SizesCfg): string;
export function planFirstSteer(up: SizeUp): string;
export function sideStopSteer(up: SizeUp): string;
export function operatorUpLine(p: { project: string; todoId?: number; up: SizeUp; side?: boolean }): string;
export const SIZE_GUIDE: string;                                              // the dispatch tool's text
```

```ts
// src/engine/size-guard.ts — one run's upgrade guard. Reads files and git (the bounded sync `git()` of
// git-read.ts); no ledger, no network. Created by dispatch like createPlanWatch / createCheckpointWatch.
export interface SizeGuardOpts {
  size: OrderSize; folder: string; project: string;
  side?: LaneKind;                       // a side lane: a move to big stops it (no plan gate there)
  cfg: SizesCfg; planPaths: string[];
  baseline?: RunBaseline; startSha?: string;
  planApproved: () => boolean;           // a plan this run held is approved → plan first ends
  onUp: (up: SizeUp) => void;            // dispatch: event, operator line, dispatcher note, todo row
  now?: () => number; git?: GitRunner; files?: GuardFiles;   // test seams
}
export interface SizeGuard {
  size(): OrderSize;
  /** The steer: a deny reason or undefined (no opinion). It never throws and never allows. */
  steer(tool: string, input: unknown): string | undefined;
  onToolUse(id: string | undefined, tool: string, input: unknown): void;
  onToolResult(id: string | undefined, isError: boolean): void;
  /** Another part of the engine found the order bigger (the plan gate held a plan). */
  raise(to: OrderSize, facts: Pick<SizeUp, "rule"> & Partial<SizeUp>): void;
  planFirst(): boolean;
  /** The run ended: measure, record a late move, say whether the todo runs again as big. */
  end(o: { planAwaiting: boolean }): SizeEnd;
}
export interface SizeEnd { size: OrderSize; requeue: boolean; measured?: ChangeMeasure; late?: SizeUp }
export interface ChangeMeasure { files: Map<string, number>; created: Set<string>; services: Set<string>; lines: number }
export function createSizeGuard(o: SizeGuardOpts): SizeGuard;
export function measureRunChange(o: { folder: string; startSha?: string; baseline?: RunBaseline; rules: SizeRules; git?: GitRunner; files?: GuardFiles }): ChangeMeasure | undefined;
```

Hooks on existing seams (all optional; absent = today's behaviour):

- `commit-finish.ts`: `runBaseline(folder, g?) → RunBaseline | undefined` (`{ root, own(path): boolean }`),
  taken out of `createCommitFinish`, which now takes it as an argument. Dispatch computes it once for each run
  and gives it to the commit finish and to the guard. The commit-finish tests stay green.
- `dispatch.ts`: `briefForSize(size, task)` (big → `briefWithProjectDocs(task)`); `dispatchToProject` opts
  `size?: OrderSize`; `DispatchHooks.onSizeUp?(up)`; `TodoEnd.size?: SizeEnd`; the steer chain becomes
  `planWatch.steer ?? guard.steer ?? (commitBrief ? undefined : checkpoint.steer)`.
- `plan-watch.ts`: option `mayHold?: () => boolean` (false → register and send, never hold); `plans(): number[]`
  (the plan ids this watch registered); `approvedHeld(): boolean`; `onHold` also calls `guard.raise("big",
  { rule: "plan" })` (dispatch wires it).
- `plans.ts`: `PlanRun.forceApproval?: boolean` → `register()` gives gate `approval` to a new version whatever its
  text says.
- `todo-queue.ts`: `submit({…, size?, operatorSize?, engineSize?})`; the row stores the size; `launch` passes
  `size: t.size`; `onSizeUp` updates the row; `finish` handles `end.size.requeue`; one `continuationOf(t, …)`
  helper for the four places that make continuations.
- `ledger.ts`: `NewTodo.size?`, `NewTodo.sizeBy?`; `TodoRow.size`, `TodoRow.sizeBy?`, `TodoRow.sizeUp?`;
  `updateTodo` patches `size`, `sizeUp`.

## 4. The tools and the operator's prefix

- `dispatch` and `todo` (`add`) take `size: "quick" | "standard" | "big"` (optional; zod enum). The `dispatch`
  description ends with `SIZE_GUIDE`; the `todo` description says "`size`: as in `dispatch`". `SIZE_GUIDE`:
  > Size (`size`) — how much process the worker runs; pick it while you write the brief. `quick`: one page or
  > screen, a small change, no data-model change (a date picker that does not clear, a wrong label) — the worker
  > just fixes it: no planner, spec, ADR or plan; one commit; a 2–3 line result. `standard`: a few files or
  > services (a list filter with its API) — a short plan in its task list, test-first, no approval gate. `big`:
  > new modules or services, migrations, auth, payment/money, prod or deploy, multi-service work — the full
  > flow; a big plan waits for the operator's Approve & build. Unsure: pick the larger. No size = `big`. The
  > operator's `/quick`, `/full` or "quick fix" overrides you. The engine moves an order UP a size when it
  > touches a sensitive area or grows, never down, and says so.
- The tools read the operator's override (§2.3) and pass `size`, `operatorSize` to `submit`.
- Every reply names the size it took and who set it: `— size quick (the operator's /quick)`, `— size standard
  (yours)`, `— size big (default: no size was given)`, `— size big (the worker SDK is Codex: a smaller size
  needs the governor hook)`.
- **Pipeline.** `handleMessage` sends a message that starts with a size override to the addressed session the
  way it sends plain text. Today any `/…` that is not a command fails with "not an order". The prefix stays in
  the text, so the chief of staff sees it. `/quick` or `/full` with nothing after it gets the reply
  `usage: /quick <order> (or /full <order>)` and goes to nobody.
- `commands.ts`: `PIPELINE_COMMANDS` gains `quick` ("send an order as a quick fix — no plan") and `full` ("send
  an order through the full plan flow"), so the Telegram "/" menu and `/help` list them.

## 5. The upgrade guard

### 5.1 What it watches

The guard is created for every Claude dispatch run (main and side), with the todo's size. It watches every tool
call: the governor hook sees the calls of helper agents too (ADR-0031). For a run that starts `big`, `steer`
has no opinion and `end` only measures. A run that the guard moved to big keeps its plan-first steer (§5.4).

`touchOf(tool, input)` builds the `Touch`:
- `Write`: the path; lines = the multiset line difference against the file on disk (all lines when it is new).
- `Edit`: the path; lines = the multiset difference of `old_string` and `new_string` lines (× the matches when
  `replace_all`). `MultiEdit`: the sum. `NotebookEdit`: the lines of `new_source`.
- `Bash`, through `walkBash` (the shared reader): redirect targets, `writeTargets`, the paths of `git rm`/`git
  mv`; lines 0 (the commit measure counts them); each simple command's head (first 4 words) for the command
  rules; a commit point when `gitCall(seg).sub` is `commit`, `merge`, `cherry-pick`, `revert`, `am` or
  `rebase`.
- `Agent`/`Task` with `subagent_type: "planner"` → `planner: true`.
- Paths outside the run's folder are not the project's change and are dropped. Paths that match
  `sizes.guard.ignore` are dropped for the rules and the limits.
- `created` = the path does not exist yet.

### 5.2 The rules (config `sizes.guard.rules`; defaults)

A rule matches a touched path when any of these matches: `paths` (Bun globs on the folder-relative path),
`names` (regex on the basename), or `words` (regex, matched as a whole word on each of `pathWords(path)`). A rule
matches a command when its `commands` (regex on the command head) match. `created: true` limits a rule to new
files. `except` globs exempt paths from that rule. All regexes are case-insensitive. One invalid regex keeps the
default rule list, as `plans.approval.patterns` does. A project can add rules and global exemptions in
`sizes.projects.<name>`.

`pathWords("ui/agency-ui/src/components/booking/PaymentMethodPicker.tsx")` = `ui agency ui src components
booking payment method picker tsx`. It splits at every non-alphanumeric character and at camelCase boundaries
(`HTTPServer` → `http server`). It does not split at digits (`oauth2`, `2fa`).

```ts
const DEFAULT_RULES: SizeRule[] = [
  { name: "migration", to: "big",
    paths: ["**/migrations/**", "**/migration/**", "**/migrate/**", "**/schema.prisma", "**/drizzle/**", "**/alembic/**"],
    words: ["migrat\\w*"],
    commands: ["^(?:goose|migrate|atlas|dbmate|flyway|liquibase|alembic)\\b",
               "^(?:(?:npx|bunx)\\s+)?(?:prisma|drizzle-kit|knex|sequelize|typeorm|sqlx)\\b.*\\bmigrat",
               "^(?:make|just|task|(?:bun|npm|pnpm|yarn)(?:\\s+run)?)\\s+\\S*migrat",
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
               "^(?:make|just|task|(?:bun|npm|pnpm|yarn)(?:\\s+run)?)\\s+\\S*(?:deploy|release|publish)",
               "^\\S*(?:deploy|release)[\\w.-]*\\.sh\\b"] },
  { name: "prod", to: "big",
    words: ["prod", "production"],
    commands: ["^(?:ssh|scp|sftp)\\b", "^rsync\\b.*\\s[\\w.@-]+:",
               "^\\S*(?:^|[/._-])(?:prod|production)(?:[/._-]|$)",
               "^(?:make|just|task|(?:bun|npm|pnpm|yarn)(?:\\s+run)?)\\s+\\S*prod"] },
  { name: "module", to: "big", created: true,
    names: ["^(?:go\\.mod|package\\.json|Cargo\\.toml|pyproject\\.toml|Dockerfile|Containerfile)$"] },
  { name: "proto", to: "standard",
    paths: ["**/*.proto"], names: ["^buf(?:\\.gen|\\.work)?\\.ya?ml$"] },
  { name: "deps", to: "standard",
    names: ["^(?:package(?:-lock)?\\.json|bun\\.lockb?|pnpm-lock\\.yaml|yarn\\.lock|go\\.(?:mod|sum|work|work\\.sum)|Cargo\\.(?:toml|lock)|requirements[\\w.-]*\\.txt|pyproject\\.toml|poetry\\.lock|uv\\.lock|Gemfile(?:\\.lock)?|composer\\.(?:json|lock))$"] },
];
```

`sizes.guard.ignore` (exempt from rules and limits): `**/*.md`, `**/*.mdx`, `docs/**`, `**/*.snap`,
`**/__snapshots__/**`, `**/*.png`, `**/*.jpg`, `**/*.jpeg`, `**/*.gif`, `**/*.webp`, `**/*.ico`, `**/*.svg`,
`**/gen/**`, `**/generated/**`, `**/*.pb.go`, `**/*_pb.ts`, `**/*_pb.js`, `**/*_pb2.py`, `**/*.gen.ts`,
`**/*.gen.go`. Generated code is exempt because its source (a `.proto`, a schema) carries the signal.

**Service.** `serviceOf(path)` is the nearest folder strictly below the repository root that holds one of
`sizes.guard.serviceMarkers` (default `Dockerfile`, `Containerfile`). A file under no such folder is shared code
and belongs to no service. For eticket-v3 this gives `services/core-service`, `ui/agency-ui` and so on;
`packages/i18n` and `services/common` are shared. The lookups are cached for the run.

### 5.3 The limits and where they are checked

- **For each call (estimate).** `judgeTouch(size, sofar ∪ touch)`. The totals are the distinct counted files,
  their changed lines and their services. `onToolUse` keeps the call's touch as pending, and `onToolResult`
  adds it to `sofar` only when the call did not fail. Apart from the commit measure below, `steer` never
  changes `sofar`, so the order of the stream and the hook does not matter.
- **At a commit point (exact).** The steer replaces `sofar` with `measureRunChange`, then judges. It uses
  `git diff --numstat --summary -z --relative <startSha>` (the working tree against the run's start, committed
  and uncommitted together), `git ls-files --others --exclude-standard -z` (new files; their lines are read,
  binary = 0, read at most 2 MB), drops the paths that `baseline.own(path)` rejects (dirty before the run and
  untouched), and drops the ignored paths. A rename counts both paths. If git cannot be read (a timeout, an
  error), the commit is denied with the measure-failed text. It is never let through without a measure. A
  folder outside git (a desk) has no commit points and uses the estimates only.
- **At the run's end (record).** `end()` measures again. It records `size_measured`. If the measure is past the
  size and no move caught it, it records a late move (`late: true`): the row's size changes and the operator
  gets the line. Nothing can be stopped any more.
- `judgeTouch` order: (1) the planner → deny if the size is quick or standard; (2) quick and a `created` path
  under the plan paths or `sizes.quick.noNewFiles` → deny `just-fix`; (3) the rule hits → the largest `to`;
  (4) the limits → the smallest size whose limits hold the totals (quick → standard → big); (5) `to` = the
  larger of (3) and (4). If `to` is above the size, the result is `up`, with the facts of the rule that decided
  (a rule hit wins a tie).

### 5.4 What "stopped and moved up" does

`up` → the guard sets its size, calls `onUp` once, and the steer returns:

- **To standard:** `upSteer`. This one call is denied and the run goes on. The worker does the call again, and
  the standard limits now judge it.
  > Not run: Neo moved this order up from QUICK to STANDARD — {reason}. Run the call again. From now on: a short
  > plan in your task list, test-first (a failing test for each behaviour you change), verify, commit in
  > checkpoints; an ADR only for a real decision; no planner and no plan file. Neo moves it up to BIG if it grows
  > past {20} files, {1000} lines or {3} services, or touches auth, money, migrations, secrets, deploy/CI or prod.
- **To big (main lane):** `upSteer`, then **plan first** until `planApproved()`:
  > STOP — Neo moved this order up from {QUICK} to BIG — {reason}. This call was not run. A big order needs the
  > operator's approval before more code changes: write the plan for the whole task (what changes, why, the
  > risks, the tests) at docs/superpowers/plans/<date>-<slug>.md — the `planner` subagent can write it — then end
  > your turn with a one-line summary. Neo sends it to the operator; Approve & build resumes you. Until then only
  > reads, Neo's tools, helper agents and Markdown files run. Leave the changes you made so far as they are.

  In plan first, the steer does not deny: the read tools of the plan hold (`Read`, `Glob`, `Grep`,
  `NotebookRead`, `ListMcpResources`, `ReadMcpResource`, `TodoWrite`, `WebSearch`), `mcp__neo__*`,
  `mcp__codebase-memory__*`, `Agent`/`Task`, and `Write`/`Edit` of `**/*.md`. Every other call gets
  `planFirstSteer`:
  > STOP — this order is BIG now ({reason}). Write its plan first (docs/superpowers/plans/…; the `planner`
  > subagent can help), then end your turn; the operator approves it before any more changes. Until then only
  > reads, Neo's tools, helper agents and Markdown files run.

  The steer only denies; the governor still judges every call that it lets through. The plan that the worker
  writes gets gate `approval` (`forceApproval`), so the plan watch holds it (ADR-0036) and the existing flow
  goes on: the card, STOP, Approve & build resumes the worker. If the run ends in plan first with no plan of its
  own that waits for approval (`end({ planAwaiting })`, read from `planWatch.plans()`), the todo is queued
  again at the head of its queue, as big, with the same row and the same `attempts`. Its result is: "Neo moved
  this order up from quick to big ({reason}); it runs again with the full flow: plan first." Its next run gets
  the big preamble, and `retryBrief` carries that result.
- **To big (side lane):** `sideStopSteer`, and every later non-read call is denied with the same text. At its end
  the todo moves to the main lane (`lane main`, `laneKind null`), size big, at the end of the main queue. A
  `code` lane's branch stays, and the result names it.
- **A guard error** (a throw inside `steer`): the call is denied with "Not run: Neo could not check this call
  against the order's size (an internal error, reported to the operator). Try once more; if it repeats, end your
  turn and say so." The error goes to `faults.report("sizeGuard", …)`. This is closed, unlike the hook's open
  path for a throwing steer.
- **Deny texts without a move:** the planner — "Not run: this is a QUICK order — no planner subagent. Just fix
  it: read the code, change it, check it, commit once. Neo moves the order up by itself if it grows." (STANDARD:
  "Plan briefly in your task list and build test-first."). A new plan, spec or ADR file in quick — "Not run:
  quick task — just fix. A quick order writes no plan, spec or ADR file. If the fix cannot be done without one,
  say so in one line and end your turn; the chief of staff sends it again as a bigger order." The measure failed
  — "Not run: Neo could not measure this order's change ({error}), and a {quick} order commits only after its
  size is checked. Run the commit again; if this repeats, end your turn and say so."

`{reason}` (`sizeReason`): `it changes 6 files (a quick order allows 5)` · `it changes 240 lines (a quick order
allows 200)` · `it changes 2 services: services/core-service, ui/agency-ui (a quick order allows 1)` · `it
touches auth: services/identity-service/auth/token.go` · `it runs deploy tooling: \`kubectl apply -f k8s\`` ·
`its plan needs the operator's approval (touches: migration)` · `it needed a context handoff`. The area names:
migration "a database migration", auth "sign-in, sessions or permissions", money "payments or money", secrets
"secrets", deploy "deploy or CI", prod "production", module "a new module", proto "an API contract (.proto)",
deps "the dependencies". A project's own rule uses its name.

**One line to the operator** (`operatorUpLine`, default priority, filed under the todo's cause):
`↑ eticket-v3 #812 quick → big: it touches auth: services/identity-service/auth/token.go — it stops and writes a
plan for your Approve & build`. For standard the tail is "— it goes on, test-first". For a side lane it is "— the
side lane stops; the todo joins the main queue as big". For a late move it is "— found after the run ended".
The dispatcher gets `[size] eticket-v3 #812 moved up quick → big: <reason>.` with `wake: false`, as with a
spin alert. Events: `size_up` (orderId; project, from, to, rule, path, command, value, max, late),
`todo_size_set` (at submit: id, size, by, chosen, override, forced), `size_measured` (at the end: size, files,
lines, services), `size_measure_failed`, `todo_size_requeued`.

## 6. The plan gate (ADR-0036 amended)

- A quick run's plan watch has `mayHold: () => guard.size() !== "quick"`. It registers and sends a plan that a
  quick worker edits, and never holds it. A quick worker cannot create one (§5.4).
- A run that the guard moved to big runs its plan watch with `forceApproval` (in the `PlanRun` that its `run()`
  returns). Each new plan version gets gate `approval`, so a plan without `approval: required` cannot slip
  through as `info`.
- A standard run whose new plan the gate holds (big by its own text): `onHold` → `guard.raise("big", { rule:
  "plan" })`. The row and the line say so. The hold works as today.
- `planWatch.approvedHeld()`: a plan this watch held now has status `approved`, `executing` or `done`. Plan first
  ends on it, so an approval that reaches a run that is still open lets the worker build.

## 7. The preambles

`briefForSize(size, task)`. The paragraphs that big shares with standard (and the security and fence paragraphs
that quick shares) become module constants, so big's output stays byte for byte the same. The existing
preamble tests stay green without edits. The rule sentences stay in `standing-rules.ts`.

**Quick** (≈ 2,700 chars; ceiling 3,000, and 3,700 with the long codebase-memory line):

```text
QUICK order — Neo's rules for a small fix: read the code, fix it, check it, commit once. No planner, spec, ADR or plan file: just fix.
First read the rule .md files of this project that the fix touches (AGENTS.md, DESIGN.md); follow them with CLAUDE.md.

REQUIRED — fix it:
  FIND — the root cause in the code, not the symptom (`superpowers:systematic-debugging` for a bug). Change the fewest lines that fix it the standard way; reuse what exists; never reformat files you did not change.
  CHECK — a test only when you change logic (failing first); run the typecheck and the tests near the change. A UI change: one screenshot in Arabic (RTL) and one in English; numbers stay LTR.
  COMMIT — one commit. ${PUSH_RULE}
  SIZE — Neo moves this order up a size, and tells you, when it grows (more than a few files or lines, or a second service) or touches auth, money, migrations, secrets, deploy/CI or prod. Then follow the rules it gives you.
  RESULT — end with 2–3 lines: the cause, the fix (files), the commit.

REQUIRED — engineering baseline: ${QUALITY_RULE} (1) i18n through the project's per-locale catalogues, AR+EN complete — never literal UI strings; numbers stay LTR in RTL. (2) `.env`, dev by default. (3) Docker. (4) No hardcoding. (5) Reuse the existing code, never a second implementation.

${SECURITY_PARAGRAPH}${FENCE_PARAGRAPH}REQUIRED — ask the operator (ask_operator) only for a real decision (product/UX policy, cost, an irreversible, prod or external action): for a non-technical reader, in the operator's language, one decision per card. Otherwise do the standard fix and report it.

REQUIRED — stay alive: Neo ABORTS a run after ~5 min with no streamed step. Run long checks in the background (background Bash or a subagent) and read each result before you end; never wrap a real test in `timeout`.

The order:
<task>
```

**Standard** (≈ 4,150 chars; ceiling 4,500, and 5,200 with the long codebase-memory line):

```text
STANDARD order — Neo's rules for a change of a few files: plan briefly, build test-first, commit in checkpoints.
First read this project's rule and doc .md files (AGENTS.md, DESIGN.md, docs this change touches); follow them with CLAUDE.md.

REQUIRED — plan briefly, then build:
  PLAN — a short plan (the steps and their tests) in your task list (TodoWrite): no plan file, no spec, no planner subagent. For a bug, `superpowers:systematic-debugging` to root-cause first. New domain words go in CONTEXT.md; an ADR only for a real decision between sound options, with the rejected ones.
  BUILD — `superpowers:test-driven-development`: a failing test first for each behaviour you change, then the code; `superpowers:verification-before-completion` before you say done. ${FINISH_RULE} ${PUSH_RULE}
  SIZE — Neo moves this order up to big, and tells you, when it grows (many files, lines or services) or touches auth, money, migrations, secrets, deploy/CI or prod: then it needs a plan the operator approves.
  RESULT — end with a short result: what changed (files), the tests, the commits.

${BASELINE_PARAGRAPH}${SECURITY_PARAGRAPH}${FENCE_PARAGRAPH}${CHALLENGE_PARAGRAPH}${ALIVE_PARAGRAPH}The order:
<task>
```

`history/extract.ts` gains one rule for each: `/QUICK order — Neo's rules for a small fix:[\s\S]*?\nThe order:\n/g`
and `/STANDARD order — Neo's rules for a change of a few files:[\s\S]*?\nThe order:\n/g`.

## 8. Visibility

**Telegram and the `todo` tool** (`sizeTag` after `#id`, in `todo-queue.ts` `renderProject`, `tag`, the ack
lines, and in dispatch's start line):

```text
📋 eticket-v3
  ▶ #812 [quick] running 3m — Fix the date picker clearing
  1. #813 [standard] Add a status filter to bookings
  ⏸ #814 [big] waiting on decision #ab12cd34 — Wallet top-up through Qi
  ↻ #815 [quick] retry 1/3 in 15m (stall) — Fix the Arabic filter label
  ✗ #816 [quick→big] failed — Fix the refund total (/todo retry 816)
  Side lanes:
  ▷ #817 [quick] side·ops running 2m — Create a dev super-admin
→ queued #813 [standard] for eticket-v3 (position 2): Add a status filter to bookings
→ dispatching to eticket-v3 [quick]: Fix the date picker clearing …
eticket-v3: done #812, starting #813 [standard] 'Add a status filter to bookings'
```

`/project <name>`: `queue: #812 [quick] running, 2 queued`. The dispatcher's `[todo]` note gains `[size] #812
moved up quick → big: <reason>` when it moved in this run.

**Quick results.** For a quick todo that ended well, the operator's result notification (`<name> finished: …`)
is clamped to `sizes.quick.resultMaxLines` lines (default 3) with `… (the full result is in thread m4f2)`. A
failure line is never clamped. The dispatcher report and the ledger keep the full text. The preamble asks for the
2–3 lines; the clamp makes sure of them.

**Console** (AR+EN catalogues; numbers and paths as LTR isolates):
- `todoRowHtml` (one place for the Queue tab and the project page): after the lead, `<span class="tchip sz
  sz-{size}">{queue.size.<size>}</span>`, plus ` ↑` and a `title` (`queue.sizeMoved`) when moved up. The
  threads view's todo line gets the same chip.
- The todo sheet: a `todoDetail.size` row — the size chip · `todoDetail.sizeBy.<by>` — and, when moved up, a
  line from `todoDetail.sizeUp.<files|lines|services|rule|command|plan|handoff>` with
  `todoDetail.area.<rule>` (a custom rule falls back to its name), plus `todoDetail.sizeUp.late`.
- `DashTodo` and `TodoDetail` gain `size`, `sizeBy?`, `sizeUp?`. CSS in `index.html`: `.sz-quick` (`--accent`),
  `.sz-standard` (`--info`), `.sz-big` (`--warn`), the pattern of `.own-*`.

| key | en | ar |
|---|---|---|
| `queue.size.quick` / `.standard` / `.big` | quick / standard / big | سريع / عادي / كبير |
| `queue.sizeMoved` | moved up from {{from}} | رُفع من {{from}} |
| `todoDetail.size` | Size | الحجم |
| `todoDetail.sizeBy.operator` / `.company` / `.engine` | set by you / set by the chief of staff / set by Neo | حدّدته أنت / حدّده مدير المكتب / حدّده المحرك |
| `todoDetail.sizeUp.files` | moved up from {{from}}: {{value}} files changed (the limit is {{max}}) | رُفع من {{from}}: تغيّر {{value}} ملفات، والحد {{max}} |
| `todoDetail.sizeUp.lines` | moved up from {{from}}: {{value}} lines changed (the limit is {{max}}) | رُفع من {{from}}: تغيّر {{value}} سطرًا، والحد {{max}} |
| `todoDetail.sizeUp.services` | moved up from {{from}}: {{value}} services changed (the limit is {{max}}) | رُفع من {{from}}: تغيّرت {{value}} خدمات، والحد {{max}} |
| `todoDetail.sizeUp.rule` | moved up from {{from}}: it touches {{area}} ({{path}}) | رُفع من {{from}}: يمسّ {{area}} ({{path}}) |
| `todoDetail.sizeUp.command` | moved up from {{from}}: it ran {{area}} tooling ({{command}}) | رُفع من {{from}}: شغّل أدوات {{area}} ({{command}}) |
| `todoDetail.sizeUp.plan` | moved up from {{from}}: its plan needs your approval | رُفع من {{from}}: خطته تحتاج موافقتك |
| `todoDetail.sizeUp.handoff` | moved up from {{from}}: it needed a context handoff | رُفع من {{from}}: احتاج إلى تسليم السياق |
| `todoDetail.sizeUp.late` | (after it ended) | (بعد انتهائه) |
| `todoDetail.area.migration` | a database migration | ترحيل قاعدة البيانات |
| `todoDetail.area.auth` | sign-in, sessions and permissions | الدخول والجلسات والصلاحيات |
| `todoDetail.area.money` | payments and money | المدفوعات والمال |
| `todoDetail.area.secrets` | secrets | الأسرار |
| `todoDetail.area.deploy` | deploy or CI | النشر أو CI |
| `todoDetail.area.prod` | production | بيئة الإنتاج |
| `todoDetail.area.module` | a new module | وحدة جديدة |
| `todoDetail.area.proto` | an API contract (proto) | عقد الواجهة (proto) |
| `todoDetail.area.deps` | dependencies | الاعتماديات |

## 9. Engine-made todos

- An Execute (`plans.ts` → `submit`) and a side-lane merge todo: `engineSize: "big"` (today's flow).
- An attention todo (`attention-actions.ts`): `ATTENTION_BRIEFS[kind].size`, overridden by
  `sizes.attention[kind]`; an unknown kind → `big`. Defaults: `quick` — `dirty`, `stale_branch`, `worktree`,
  `unpushed`, `no_upstream`, `decision_stale`, `thread_waiting`; `standard` — `ci_failed`, `dependabot`,
  `pr_open`, `pr_review_requested`, `thread_failed`, `dispatch_spinning`, `queue_paused`, `approval_stuck`,
  `skillify_repeat`, `ctx_window_suspect`, `note_finding`, `note_fyi`, `drift`; `big` — `code_scanning`,
  `secret_scanning`, `note_request`, `issue_open`, `history_off`, `history_degraded`, `backup_failed`,
  `restart_gated`. A test checks that every kind in `ATTENTION_BRIEFS` has a size.

## 10. Config (`sizes`, docs/CONFIG.md)

```json
{ "sizes": {
    "enabled": true,
    "default": "big",
    "side": { "read-only": "quick", "ops": "quick", "test": "quick", "code": "standard" },
    "override": { "quick": ["/quick", "quick fix", "إصلاح سريع"], "big": ["/full"] },
    "quick":    { "maxFiles": 5,  "maxLines": 200,  "maxServices": 1, "resultMaxLines": 3, "noNewFiles": ["**/adr/**"] },
    "standard": { "maxFiles": 20, "maxLines": 1000, "maxServices": 3 },
    "guard": { "rules": "<DEFAULT_RULES, §5.2>", "serviceMarkers": ["Dockerfile", "Containerfile"], "ignore": "<§5.2>" },
    "attention": {},
    "projects": { "<project>": { "rules": [], "except": [] } } } }
```

A missing or badly typed field keeps its default. `default` and the `side` values must be sizes. The limits are
integers ≥ 1. A rule list with one invalid entry keeps the whole default list. `enabled: false` means every
order is big, with no guard and no override (today's behaviour). The config is read live from `cfg.sizes`, so a
reload applies it (a reload is the operator's call).

## 11. Ledger v18 ("todo sizes", frozen once shipped)

```sql
ALTER TABLE project_todos ADD COLUMN size TEXT NOT NULL DEFAULT 'big';
ALTER TABLE project_todos ADD COLUMN size_by TEXT;   -- operator | company | engine; NULL on rows before v18
ALTER TABLE project_todos ADD COLUMN size_up TEXT;   -- JSON SizeUp of the latest move up; NULL = never moved
```

`mapTodoRow`: an unknown `size` reads as `big` (fail safe); bad `size_up` JSON reads as none, never a throw.
The history feed triggers (v17) watch other columns, so a size change writes no feed row. `migrate()` makes
`ledger.db.bak-v<from>` once, before the first pending migration (`VACUUM INTO`). The live ledger is about 450 MB
today, so the restart needs that much free disk.

## 12. Acceptance criteria

1. **Model.** `ORDER_SIZES` is `quick < standard < big`; `larger` and `isOrderSize` work; `readSizesCfg` gives
   §10's defaults, and a bad field (a size that is not one, a limit of 0, a bad regex) keeps its default.
2. **Override.** `parseSizeOverride`: `/quick fix the picker` → quick (rest "fix the picker");
   `/quick@neo_bot x` → quick; `/full x` → big; `Quick fix: x` → quick; `إصلاح سريع: x` → quick; `this is not a
   quick fix` → none; `/quickly x` → none; `/quick` → quick with rest "".
3. **Resolve.** The precedence of §2 holds for each pair (`forced` beats `override` beats `chosen` beats
   `engine` beats `side` beats `default`), with `by` and `why`. `enabled: false` → big for every input.
4. **The operator's message only.** The tools read the override from the live operator message (role user,
   surface telegram or web), else from the root of the work's thread when that root is such a message. A
   company turn that a schedule fired, an engine-written root, or an assistant message gives none. A `/full`
   in the live message beats a `/quick` in the thread root.
5. **Ledger v18.** A v17 ledger with rows migrates to 18 with the same row counts and a `.bak-v17` backup. Old
   rows read `size: "big"` and `sizeBy: undefined`. `addTodo` stores size and sizeBy; `updateTodo` patches size
   and sizeUp (JSON round trip); a bad JSON reads as none. Reopening runs nothing. The v17 migration test pins its
   list to `version <= 17`.
6. **Preambles.** `briefForSize("big", t) === briefWithProjectDocs(t)`, and every existing preamble test is green
   without edits. Quick contains `PUSH_RULE`, the security paragraph, the fence paragraph, "numbers stay LTR",
   "AR+EN", "just fix", "2–3 lines" and "`history_search`". It contains none of `PLAN_RULE`, "`planner`
   subagent (", "writing-plans", "BIG plan". Standard contains `FINISH_RULE`, `PUSH_RULE`, `QUALITY_RULE`,
   `TECH_RULE`, `STOP_RULE`, "test-driven-development", the security and fence paragraphs, and neither
   `PLAN_RULE` nor "`planner` subagent (". The ceilings of §7 hold.
   `stripEngineBlocks(briefForSize(s, TASK)) === TASK` for every size.
7. **Sensitive rules.** For each default rule, a representative path or command moves a quick run and a
   standard run to the rule's size, and the call is denied with `upSteer`. Negative cases stay quick: `author.ts`,
   `authority.go`, `docs/adr/0001-auth.md`, `src/pipeline.ts`, `src/components/ui/date-picker.tsx`,
   `.env.example`, `grep -r prod src`, `cat migrations/001.sql`. Positive cases: `services/common/authcontext/x.go`,
   `ui/admin-ui/src/components/users/RolePicker.jsx`, `ui/agency-ui/src/components/booking/PaymentMethodPicker.tsx`,
   `.env.local` (root and nested), `docker-compose.prod.yml`, `.github/workflows/ci.yml`, `migrations/310_x.sql`,
   `npx prisma migrate dev`, `kubectl apply -f k8s`, `ssh prod-1`, a new `services/x/go.mod`; `api/booking.proto`
   and `package.json` → standard.
8. **Limits.** Quick: the call that makes 6 files, 201 lines or 2 services is denied once; the size becomes
   standard; the same call again is allowed. Standard: at 21 files, 1001 lines or 4 services it moves to big. A
   quick call that passes standard's limits at once goes straight to big. Ignored paths count for nothing. A
   failed call adds nothing. A write outside the folder adds nothing.
9. **Commit measure.** In a temp git repo, at `git commit`, `git -C <repo> commit`, `git merge` and `git
   cherry-pick`, the guard measures with git: committed and uncommitted changes since the start, plus untracked
   files, minus paths that were dirty at the start and are untouched, minus the ignored paths. It judges the
   result. A Bash-made change that the estimate missed (`sed -i` on 6 files) moves the order at the commit. When
   git fails, the commit is denied with the measure-failed text.
10. **Planner and plan files in quick.** `Agent`/`Task` with `subagent_type: "planner"` is denied in quick and
    standard, allowed in big and after a move to big. A new file under the plan paths or `**/adr/**` in quick is
    denied with "quick task: just fix" (Write, and a Bash redirect). An edit of an existing plan file is allowed.
11. **Plan first.** After a move to big, the calls listed in §5.4 are not denied, and every other call (Bash
    included) gets `planFirstSteer`. Plan first ends when `approvedHeld()` is true.
12. **Plan gate.** A quick run that edits an existing big, unapproved plan sends its card and is not held. A plan
    written in a run that was moved to big gets gate `approval` even when its text is small. A standard run held
    by its own big plan records a size up with rule `plan`.
13. **Run end.** `size_measured` is recorded for every guarded run. A quick run whose final measure passes its
    limits records a late move and the operator line, and its row changes. A run that ends in plan first with no
    plan of its own that waits: its todo is `queued` at position 1, as big, with the same `attempts`, and its
    next brief carries the size-up result. A run that ends with such a plan: its todo ends as today (done), and
    its result says that the plan waits for Approve & build.
14. **Side lanes.** Unsized side briefs get the kind defaults. A side lane moved to big is stopped
    (`sideStopSteer` on every non-read call). At its end its todo is in the main lane, as big, at the end of the
    queue, and the line names a `code` lane's kept branch. A `big` side brief from the tool runs in the main
    lane, and the reply says why.
15. **Continuations and retries.** A retry keeps the size. A checkpoint or handoff continuation of a quick todo
    is standard, with `sizeUp.rule = "handoff"`. Others keep their size and their `sizeUp`.
16. **Forced big.** A Codex own-work setup, a customer-driven dispatch and a team order are big. The reply says
    why, and no guard is created on Codex.
17. **Quick results.** A quick todo's good result line is at most `resultMaxLines` lines plus the pointer to its
    thread. A failure is never clamped. The dispatcher report keeps the full text.
18. **Tools.** `dispatch` and `todo add` accept `size` and reject a value that is not a size. `size` reaches
    `submit`. The `dispatch` description contains `SIZE_GUIDE`. Every reply names the size and who set it.
19. **Pipeline and commands.** `/quick fix x` and `/full x` reach the company as text (not "not an order"). A bare
    `/quick` gets the usage line, and nothing is delivered. `telegramCommands()` and `/help` list `quick` and
    `full`.
20. **Telegram views.** `/todo`, `/todo <p>`, the `todo` tool's list, the queued, side-queued, start and
    transition lines, and `/project` carry `sizeTag` as in §8.
21. **Console.** Every todo row and the threads view's todo line show the size chip, with the move-up mark and
    title. The sheet shows the Size row and the reason from catalogue templates. The catalogue parity test is
    green (the new families exist in both languages with the same placeholders). An RTL and an LTR screenshot of
    the Queue tab and the sheet show the numbers and paths LTR.
22. **Attention kinds.** Every `ATTENTION_BRIEFS` kind has a size. `sizes.attention` overrides it. An unknown
    kind is big. An attention todo is stored with `by: "engine"`.
23. **Safety.** The governor tests (`governor*.test.ts`, `lanes-governor.test.ts`) are unchanged and green. A
    push is an operator-only escalation at every size. The steer has no allow path: with the guard in front, a
    call that the governor denies is still denied. A guard error denies the call and reports one engine fault.
24. **Docs.** `docs/CONFIG.md` has the `sizes` row. CONTEXT.md has the terms. `CLAUDE.md` item 6 is edited in
    place (the file stays at 200 lines). The company's `agent/CLAUDE.md` has the section of the plan.
    `docs/HISTORY.md` has an entry. ADR-0072 is marked accepted, with an "As built" section.

## 13. Edge cases

- **Parallel calls** in one assistant message: each steer is synchronous and sees the moves made before it.
  Two writes in one message can still pass a limit together. The next call or the commit measure catches it
  ("~5 files" is a limit, not an exact count).
- **A repository-wide formatter** in a quick order reads as a big change at the commit. The quick preamble says
  "never reformat files you did not change".
- **A folder that was dirty before the run:** those paths are the run's only when it changes them (the
  fingerprint, ADR-0037). The commit finish and the guard share one baseline.
- **A rename** counts both paths; a deletion counts; a binary file counts as a file with 0 lines.
- **The commit finish turn** (ADR-0037): its commit is judged too. A move there denies the commit; for big, the
  plan first applies, and the commit-finish outcome line ("still uncommitted") tells the operator.
- **An armed context checkpoint:** the guard's deny comes first, then the checkpoint's.
- **A plan card that cannot be posted** (ADR-0036 lets the worker go): the run-end card waits. The run wrote a
  plan that waits for approval, so the todo is not queued again.
- **The operator drops the plan in plan first:** plan first stays, the worker ends, the todo ends as today, and
  the uncommitted files raise the `dirty` item. The operator decides.
- **A restart in plan first:** ADR-0027 retries the todo, and the row is already big.
- **A todo moved twice** (quick → standard → big): `size_up.from` stays `quick`, and the rule is the latest one.
- **A `/quick` thread** that later gets an unrelated big brief from the chief of staff: the thread root's
  override still applies. The guard still moves any sensitive or growing work up. The company rules tell the
  chief of staff to start a new order with a new message.
- **The operator's `/quick` while a project is pinned in focus:** the text goes to that project's session (the
  operator path, no size).
- **A non-git folder** (a desk): no commit points; the estimates only.
- **A repository with no commit at the run's start:** the measure diffs against git's empty tree.
- **A plan written to a path that is not a plan path** (`PLAN.md` at the root) in plan first: the plan watch does
  not see a plan, so at the run's end the todo is queued again as big. The steer text names the plan path.
- **Codex:** big; the preamble is big; no guard.
- **Old rows:** big, set by Neo.
- **Execute of an approved plan:** big. Its plan is approved, so the gate does not hold it again (ADR-0034 rule 4).

## 14. Out of scope

- Sizes for loops (`loop_defs`). Loops keep `loopBrief` (ADR-0063). A loop may ask for lighter rules in its
  own prompt.
- Operator-opened sessions (`/open`, a focused chat).
- A model or an effort for each size (worker profiles, ADR-0005).
- An AI classifier for unsized briefs.
- A code check for the screenshot (the preamble asks for it; the LTR rule stays in the baseline).
- The size in the task history's search text.
- Any move down.

## 15. Files

New: `src/engine/order-size.ts`, `src/engine/size-guard.ts`; tests `tests/order-size.test.ts`,
`tests/order-size-rules.test.ts`, `tests/size-measure.test.ts`, `tests/size-guard.test.ts`,
`tests/size-briefs.test.ts`, `tests/dispatch-sizes.test.ts`, `tests/todo-sizes.test.ts`,
`tests/size-tools.test.ts`, `tests/console-sizes.test.ts`.

Changed: `src/engine/ledger-migrations.ts` (v18), `src/engine/ledger.ts`, `src/engine/standing-rules.ts`
(the shared quick-rule sentences if they are reused), `src/engine/dispatch.ts`, `src/engine/plan-watch.ts`,
`src/engine/plans.ts`, `src/engine/commit-finish.ts`, `src/engine/todo-queue.ts`, `src/engine/pipeline.ts`
(`handleMessage` branch 1, `dispatchDepsFrom` adds `sizes`), `src/engine/commands.ts`,
`src/engine/attention-briefs.ts`, `src/engine/attention-actions.ts`, `src/engine/dashboard.ts`,
`src/engine/project-view.ts`, `src/engine/history/extract.ts`, `src/config.ts`, `src/frontends/web/app.ts`,
`src/frontends/web/index.html`, `src/frontends/web/locales/{en,ar}/console.json`; tests
`tests/ledger-migrations.test.ts`, `tests/standing-rules.test.ts`, `tests/history-extract.test.ts`,
`tests/plan-gate.test.ts`, `tests/todo-queue.test.ts`, `tests/console-i18n.test.ts`, `tests/commit-finish.test.ts`.

Docs: `docs/CONFIG.md`, `CONTEXT.md` (written with this design), `CLAUDE.md` (item 6, in place),
`docs/HISTORY.md`, `docs/adr/0072-…` (accepted after the build), and the untracked
`/home/neo/agent/CLAUDE.md` (the company's rules; edited in place by the build — see the plan).
