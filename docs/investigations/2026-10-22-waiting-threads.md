# Waiting threads that look finished — investigation (2026-10-22)

The operator's screenshot showed many WAITING threads that look finished. This note records how we
checked each one. Method: we read a `VACUUM INTO` copy of the live ledger. Each verdict comes from
read-only evidence in the target repository: commits, plans, docs and HANDOFF notes. Nothing was
guessed from a title. Decision ids are the first 8 characters.

## Facts

- The console's per-project numbers (neo 98, eticket-v3 55, gold 64, waselni 45 …) are **all**
  threads. Only **20** threads were `waiting`, holding **28** open decisions. The other 74 open
  decisions have no thread (they are older than the trace spine).
- Every one of the 20 is held by a real `ask_operator` question or plan card that was never answered
  and never closed. Each was reminded once.
- If ADR-0038 (on `dev`, not live) is applied to the copy, 1 of the 20 threads is settled.

## Verdicts

| Thread | Project | Decision | Verdict | Evidence / ask |
|---|---|---|---|---|
| m9g0b | contantme | d8de5017 | done | `docs/VALIDATION.md`: "skipped by operator decision (#d8de5017, answered as #86b3d086)" |
| m74i2 | mirshad | 8c5ad70f | done | `f279ee4f` (cites "Operator decision #8c5ad70f", ADR-0033) |
| m74i2 | mirshad | f4cf5967 | done | `d3996242` (cites "Operator decision #f4cf5967", ADR-0034) |
| ma18s | neo | d184a612 | done | decision #cc6ffca9 "keep everything" (10-18); ADR-0041 `e6b1baf` |
| mae06 | neo/agent | 4c4b5a74 | done | eticket-v3 `05e67d3e9`…`6ef58c71c` (ADR-0178): the sandbox needs no Qi public key |
| m9ygk | prod-ops | 2f66c3ce | done | prod-ops `98aea90` (cites #2f66c3ce); the E2E passed in `bda6d40` |
| macay | prod-ops | 42eba2cd | done | prod-ops `c25605d` "Deploy ADR-0020 archiver alert rules (approval #42eba2cd)" |
| m9pfe | waselni | b38c679a | done | `4da7c994` (ADR-0081, auto-update); on main `8d628cdc` |
| m9piu | waselni | ae3b5fa0 (plan) | done | built: `e845c79f`, `1187356e` (ADR-0083); on main `8d628cdc` |
| m9yn1 | waselni | f7387f7e | done | `8f14a9d8` (ADR-0091) on main; `cea94519`: deployed + prod OTA |
| m9ytv | prod-ops | d1b477b6 | done | prod-ops `docs/wallet-payment-crash-check-2026-10-18.md`: running `58d44fa`; then `17e5d7d` |
| m7ijm | eticket-v3 | a6e6778b | done | `8c6d85446` (SEC-1) in main `de2901ee3`; deployed 10-18 |
| m7nk8 | eticket-v3 | 3a39e3c8 | done (moot) | ADR-0171 `f55a1f3be`: no binding means refused, so no such sale |
| m7wys | eticket-v3 | 041de41a | done | answered by #88276783; merge `6ce3a1695` on dev and main |
| m7nk8 | eticket-v3 | d3226770 | **unclear** | no recorded prod check; ADR-0171 is on dev only |
| m7hji | eticket-v3 | ba954c7c | needs operator | Where should support agents see the AI chat from before a hand-off? |
| m7ijm | eticket-v3 | a1b13247 | needs operator | How is a booking change's price difference paid from the wallet? |
| m9snq | eticket-v3 | 789a27fb | needs operator | payment_tokens: build the table or remove the three RPCs? |
| m9snq | eticket-v3 | 73c66293 | needs operator | Charter-hotel manager RPCs and pricing-rule model: build or remove? |
| m9ytv | eticket-v3 | 01441714 | needs operator | An iQtkt prod admin login (or you run it) to fail the 23 stuck IA bookings |
| m9ytv | eticket-v3 | b2cd43d9 | needs operator | Purge passenger PII from prod Loki (it expires by itself around 11-01)? |
| ma71j | eticket-v3 | f5559e7d | needs operator | Which account do the partner-less background syncs use under "nothing shared"? |
| ma8ox | eticket-v3 | d3ed03e2 (plan) | needs operator | Approve, change or drop the CityNet Asfoor dev-first plan |
| m7wys | eticket-v3 | 81396fd2 | needs operator | Enforce allow_api_client for API-key tokens at the gateway? |
| maby3 | prod-ops | 1f7d20a3 | needs operator | Sandbox admin needs super-admin: SQL grant, create it in the UI yourself, or share a login? |
| mab0w | contantme | 2598e346, 80371ae2 (plans) | needs operator | Approve & build the Bitaqti upgrade roadmap, or park it? |
| m8k9f | gold | da926828 | needs operator | Which Telegram bot and channel feed prices, and in what post format? |

The threads closed by the cleanup are m9g0b, m74i2, ma18s, mae06, m9ygk, macay, m9pfe, m9piu and
m9yn1. m9ytv, m7ijm and m7wys stay WAITING on their other decisions. m7nk8 stays WAITING (unclear).

## Found on the way

- **Security:** the root message of thread m9ytv holds a sandbox login **and its password** in plain
  text (the operator typed it). It sits in the ledger and every backup of it. Rotate that sandbox
  password. The value is not repeated here.
- Several project HANDOFF notes still say "waiting on #…" for questions that are done (prod-ops on
  #d1b477b6). They belong to those projects.
