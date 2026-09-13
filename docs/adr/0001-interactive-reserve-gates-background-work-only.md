# The interactive reserve gates background work only

**Status:** accepted (2026-09-13)

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
