# The interactive reserve gates background work only

**Status:** accepted (2026-09-13) · amended the same day — work class now follows the originating
trigger (see "Amendment" below)

The budget guard exists to stop background work from draining the subscription the operator uses
themselves. It was applied to the wrong side: the operator's own interactive turns were refused
("throttled: protecting interactive headroom") once background spend passed the reserve, while
background dispatches were never checked against it at all. We therefore make the work class
explicit and gate on it: **background work is subject to the interactive reserve; an interactive
turn never is.** `Meter.shouldThrottle` is renamed `shouldThrottleBackground` so no call site can
gate an interactive turn without the name reading obviously wrong.

## Considered options

- **Give interactive turns a higher threshold** (throttle them only at 100% of the window budget
  rather than at the reserve). Rejected: the reserve is defined as the slice background work may
  not touch, so an interactive turn hitting *any* engine-local ceiling means the reserve failed to
  do its job. A softer wrong answer is still a wrong answer.
- **Keep one class-blind `shouldThrottle` and pass a flag at each call site.** Rejected: this is
  the shape that produced the bug. A flag defaults to something, and the default was wrong; a name
  cannot default.

## Consequences

The engine now has exactly one authority that may refuse an operator's interactive turn: Anthropic
itself, via a real rate limit. When the engine knows a rate-limit window is rejecting us it
**warns** the operator with the real reset time and starts the turn anyway, rather than refusing on
a possibly stale snapshot — failing closed against the operator is the failure mode being removed
here, and the existing retry path already reports an actual refusal honestly.

Making background dispatch honor the reserve is a real behaviour change: a dispatch that would
previously have started while over budget is now held. That is the intended meaning of the reserve,
and the operator can still run the same work as an interactive turn — `budgetHoldMessage` says so,
and names the spent-vs-allowance figures so a hold diagnoses itself.

**The default `budgetWindowUsd` is now the live question.** `dispatchToProject` has exactly one
caller — the company session's `dispatch` tool — so most holds will land on work the operator just
asked for conversationally, one hop from their message. At the `20` default the background
allowance is $16, while real dispatches on this box cost $10–35 each (measured 2026-09-13), so a
single dispatch can arm the hold for the rest of the window. The gate is correct; the number is a
cost decision for the operator, so this ADR deliberately does not invent a new one.

A follow-up worth considering, not built: let work class follow the *originating trigger* rather
than the mechanism, so a dispatch made while servicing an operator turn inherits `interactive`
while a scheduler-fired one stays `background`. That would remove the relocation entirely. It needs
a class threaded from the session that owns the `dispatch` tool, which is more than this fix.

## Amendment (2026-09-13): work class follows the originating trigger

The follow-up above is now built, on the operator's call. The paragraph before it framed the
`budgetWindowUsd` default as the live question; it was the wrong question. `dispatchToProject` has
exactly one caller — the company session's `dispatch` tool — and that session is one hop from the
operator's own message, so at any sane dollar figure the hold lands on conversational orders. No
number fixes a rule that classifies by mechanism.

**The rule:** work is `interactive` or `background` by what TRIGGERED it. An operator message
(`handleMessage` — every caller uses the default `source: "neo"`) launches an `interactive` worker,
and the `dispatch` tool that worker holds dispatches as `interactive`; a sub-worker inherits the
same class again. Only scheduler-fired work is `background`: loop fires, cron/automations, the
secretary, the dream/memory sweep, and the customer-brief ingress run (nobody is at the keyboard for
that one either). The class is decided once, at worker launch, and captured in the tool's closure —
never re-derived at a call site and never inferred from the mechanism.

### Considered options

- **Raise `budgetWindowUsd` instead.** Rejected: it treats a classification bug as a calibration
  problem. Whatever the figure, a mechanism-based rule still counts the operator's own conversational
  orders against a reserve held *for* them, so the same refusal returns one busy day later.
- **Gate dispatch on the meter only when no operator session is live.** Rejected: liveness is not
  the question — a company session sits registered and idle forever, so this reads "almost always
  interactive", which is a coincidence, not a rule.
- **Make the class a required field everywhere.** Rejected on cost, not on principle: it would touch
  ~60 existing test call sites for no behavioural gain. Instead the class is optional with an
  explicit `DEFAULT_WORK_CLASS = "background"`, pinned by its own test.

The earlier rejection of "one class-blind predicate plus a per-call-site flag" still stands and is
not contradicted here. The meter's method is still named `shouldThrottleBackground`, still cannot
produce a hold for interactive work, and call sites do not re-derive the rule: they call
`heldByReserve(workClass, meter)`, the one function that answers "does the reserve apply?". What is
threaded is a *fact about the work* (what triggered it), decided at exactly one point per launch —
not a per-call-site opinion about whether the guard should apply.

### Consequences

- The engine-side budget guard now bites only on scheduler-fired work. That work already had two
  other gates on the same predicate (the scheduler's `throttled` tick guard and each loop's
  `shouldStop`), so the reserve is enforced where it was always meant to be.
- Loop workers hold no `dispatch` tool today, so "a loop-originated dispatch" is currently
  unreachable in production. It is wired and tested anyway, because the class rides on the launch:
  the day a loop gets the tool, it is background without anyone remembering to make it so.
- Unclassified work is background. A forgotten wiring can therefore only over-protect the reserve —
  a visible hold that names its numbers and that `/open` bypasses — never silently disable it.
- Dispatch events carry `workClass`, so `dispatch_end`'s existing `costUsd` can be split into
  interactive vs background spend without any new accounting.
- Known edge: the class is captured per *worker launch*, so a message that queues as a follow-up
  into an already-live worker inherits that worker's class rather than its own. The only way to hit
  it is an operator message landing while a customer-brief ingress run holds the company session, a
  window of seconds; `/open` is the escape hatch. Not worth per-message re-classification.
- `budgetWindowUsd` keeps its `20` default, and it is no longer urgent: it now governs background
  work alone, which is what its name always claimed.
