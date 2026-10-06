# The worker model is pinned in config, not inherited from the SDK

**Status:** accepted (2026-10-01)

Nothing in Neo chose a worker model. `WorkerProfile.model` existed and `profileDeps` threaded it
(`src/engine/worker-profile.ts:18`), but every shipped profile was `{}` or effort-only
(`src/config.ts:245`) and `config.json` was empty. So `RunDeps.model` was `undefined` on every
launch path, `resolveModelSelection` returned it unchanged (`src/engine/model-resolver.ts:184`), and
`runConfig` omitted `model` entirely. Every worker silently took whatever the subscription default
happened to be that day.

That is an unrecorded dependency on an external default:

- A tier change needs **no config change** and leaves **no record** — the engine cannot say which
  model did a piece of work, and the operator cannot pin, roll back, or diff it.
- The engine's own doc was already wrong because of it: `CLAUDE.md` told every worker to sign
  commits `Claude Opus 4.8 (1M context)` while workers had moved to Opus 5, so commits across
  several repos are signed with a model that did not write them.
- It contradicts "AI *decides*; the engine *acts and governs*." A cost-and-capability choice that
  the engine neither sets nor records is not governed.

The upgraded bundle (`@anthropic-ai/claude-agent-sdk` 0.3.286) makes the same argument itself. Its
own validation text rejects bare aliases in an allowlist with: *"it names a different model
depending on the release and settings. Name the model instead, for example `claude-opus-5-5`."*

## Decision

1. **One config block names the models: `models`.** `models.default` is the model every launch path
   gets; `models.aliases` maps a tier word to a real model id. Both resolve through the existing
   env > `config.json` > defaults precedence (`loadConfig`).

2. **Real model ids are pinned, aliases are only a spelling.** `models.aliases` exists so a profile
   or a brief can keep saying `opus`, but the alias is expanded to a pinned id *before* it reaches
   the SDK. Nothing downstream ever sends a bare alias, so no release can re-point it under us.

3. **`profileDeps` is the one resolution point.** It already is the only place path→model routing
   happens, and it is the only place that holds both the config and the `RunDeps`. The fallback
   chain is `base.model ?? profile.model ?? models.default`, then alias expansion. No launch site
   names a model, so there is nothing to keep in sync.

   The cost of that design is that every launch path must *hand it* the config. `DispatchDeps` is
   assembled field by field rather than passed whole, so `models` has to be threaded explicitly
   (`src/engine/dispatch.ts`, from `pipeline.ts` and `ingress.ts`) — and a first cut of this change
   shipped without it, leaving dispatch, the path nearly all project work takes, still inheriting.
   A unit test on `profileDeps` could not catch that, because it passes the config directly. The
   guard is a test that drives a real dispatch and reads the `RunDeps` the worker is started with
   (`tests/dispatch.test.ts`).

4. **An unset or blank model lands on `models.default`; an unrecognised id passes through.** The
   bug being fixed is *absence*, so absence gets the default. A string the alias map does not know
   is forwarded untouched, because the SDK is the authority on whether an id is real and already
   reports it precisely (`classifyApiError` → `model_not_found`,
   `src/engine/session-runner.ts:211`). Clobbering it would break the Codex path, where
   provider-native ids like `gpt-5.4` are legitimate.

5. **The SDK compatibility table keeps owning per-provider degradation.** On Claude it expands a
   tier alias to its pinned id — both the bare word and the `[1m]` spelling, generated from the pins
   so a new tier cannot be added and forgotten. On Codex, **no Claude name may pass through as a
   literal model**, because none of them is an OpenAI model, and **every rule sets an effort**
   including the catch-all: leaving it unset hands the run to Codex's own default silently, which is
   this same defect one layer down. `fable` and the mode aliases were in neither table before, so
   `best` reached Codex as the literal model `"best"` and `claude-fable-5-1` fell through the
   `^claude-` catch-all with no effort.

   `best` and `opusplan` are **not** pinned on Claude: they depend on the release *and* the settings,
   so no single id expresses them, and substituting one would change what they mean rather than make
   them stable. The invariant is therefore about **tier** aliases, not every Claude name.

6. **The default is `claude-opus-5-5[1m]`.** Opus 5.5 is the newest Opus the bundle exposes, and
   `[1m]` preserves the 1M context workers already run on today, so this pins current capability
   rather than changing it. `[1m]` is a context-size tag the bundle strips from any canonical id
   (`c.replace(/\[1m\]$/i,"")`), and the API accepted `claude-opus-5-5[1m]` in a live probe.
   The cheap paths stay plain: 1M context on a judge or handoff run is cost with no benefit.

## Considered options

- **Pin the bare aliases `opus` / `sonnet` / `haiku`.** Rejected: that is the status quo wearing a
  config key. The alias is release-dependent by design — the SDK says so in the text quoted above —
  so a tier change would still arrive silently, which is the whole defect.

- **Thread `cfg` into `resolveModelSelection` and expand aliases there.** Rejected: `runConfig` and
  `codexThreadOptions` take `RunDeps` alone and have no config, so this would mean passing config
  through the SDK boundary purely to look up a string. `profileDeps` already has both and is already
  the documented single routing point; expanding there keeps the resolver a pure function of its
  arguments.

- **A per-path model in every profile, no global default.** Rejected: eight places to edit, seven of
  which would say the same thing, and a newly added launch path would silently inherit again. One
  default plus overrides means the default is stated once and a path only speaks up to differ.

- **Fall back to the default for any unrecognised model string.** Rejected: it masks typos as a
  working config and it clobbers provider-native Codex ids. A wrong model id should fail loudly at
  the SDK, which already classifies it.

- **Plain `claude-opus-5-5`, dropping `[1m]`.** Rejected: workers run 1M context today, so this
  would be a silent capability cut dressed up as a pin.

- **Also derive the context window from the pinned model** (`MODEL_WINDOW_TOKENS`,
  `src/engine/context-policy.ts:18`) so occupancy is measured against the real window. Rejected
  *here*, recorded as follow-up, and worth being precise about the reason.

  The facts map is keyed on the model a transcript reports, and a `[1m]` run reports
  `message.model` as `claude-opus-5-5` with the tag stripped — so from the transcript alone the map
  cannot tell a 1M run from a 200k one, and keying 1M to that id would make a 200k worker look 5x
  emptier than it is and never hand off. But that is no longer the whole story: after this ADR the
  **engine itself chooses the tag** at one resolution point, so the resolved `RunDeps.model` knows
  the context size even though the transcript does not. The honest reason for deferring is therefore
  not "it cannot be known" — it is that plumbing the resolved model into the occupancy calculation
  changes when every session hands off, by about 5x. That is a behaviour change with its own risk
  profile and deserves its own decision and its own measurement, not a ride-along.

  Today's behaviour is unchanged by this ADR: workers already ran a 1M context against a 200k
  assumption, so sessions already hand off at roughly 13% of real occupancy. Conservative, wasteful,
  and now written down.

## Consequences

- The model a worker runs is now a reviewable line in `config.json` and a diffable change.
- Upgrading a tier is a config edit plus a daemon reload — deliberate, not ambient.
- `models.aliases` must be revisited when a newer tier ships. That is the point: it is the record.
- Occupancy is still measured against 200k for every model, so sessions hand off earlier than a 1M
  worker needs. Pre-existing, unchanged, and now written down.
