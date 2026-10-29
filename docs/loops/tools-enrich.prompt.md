Improve Neo's shared tools catalogue from what tool searches missed this week. You start fresh every
iteration and remember nothing: the catalogue on disk and the miss list are your memory. The catalogue
is `docs/tools/*.md` in /home/neo (ADR-0044); its rules are in `docs/tools/README.md`.

## Each iteration

1. Read what missed: `bun tools/catalogue/misses.ts list`. Each line is a term from a `tools_miss`
   event (a `tools_for` search or a dispatch tools hint that found no tool) since the last run, how
   often it missed, and which projects searched for it. If it prints "no search missed", stop.
2. Make a worktree for your change, outside /home/neo, from `dev`:
   `git -C /home/neo worktree add /tmp/neo-tools-enrich-<date> -b chore/tools-enrich-<date> dev`, then
   `ln -s /home/neo/node_modules /tmp/neo-tools-enrich-<date>/node_modules`. Work only in that worktree.
3. For each term that names a real need an existing card meets, add the term to that card's `tags`
   (lowercase words, at most 12) or a one-line task to its `examples` (at most 6). Arabic terms are
   welcome as tags. Ignore terms that are noise (ids, numbers, one-off names).
4. When a term names a need no card meets, and a real tool on this host meets it, add a NEW card with
   `status: candidate`. Never set or promote a card to `active`, and never change a card's `status`,
   `scope`, `env` or `relay`: those are the operator's decisions.
5. Run `bun test tests/tools-catalogue.test.ts` in the worktree. Fix your card until it is green.
6. Commit on the branch with a message that lists the terms you used. Then remove the worktree
   (`git -C /home/neo worktree remove /tmp/neo-tools-enrich-<date>`); the branch stays.
7. Mark the misses handled: `bun tools/catalogue/misses.ts mark --branch chore/tools-enrich-<date>`
   (the engine checks the branch exists). When every term was noise and you changed no card, run
   `bun tools/catalogue/misses.ts mark --none "<one line: why>"` instead, and make no branch. The
   loop's goal (`misses.ts check`) is met only after a mark.

## Rules

- Change only `docs/tools/`. No code, no config, no other project. Do not push, merge, deploy or restart.
- A card holds key NAMES only, never a value. Never copy a brief or customer text into a card.
- The miss list holds search terms only; keep it that way in your commit message.

## Your reply (the only thing the operator sees)

Two or three lines: how many misses, which cards you changed and with which terms, the branch name, and
any new candidate card the operator may want to make active. No preamble.
