# A test run keeps its temp folders in one root it removes

**Status:** accepted (2026-10-18). Related: ADR-0040, ADR-0041.

On 2026-10-18 `/tmp` held about 61,000 `neo-*` folders, and about 4,600 more came every day. Neo's
tests make temp folders with `mkdtempSync(join(tmpdir(), "neo-…"))` in about 100 places, and most
never remove them. Each full `bun test` run left about 1,000 folders. The disk-cleanup loop only
deletes them after 7 days, and the next runs make new ones.

## Decision

The test preload (`tests/preload.ts`) makes one **test temp root** per run (`$TMPDIR/neo-test-XXXX`)
and sets `process.env.TMPDIR` to it before any test file loads. `os.tmpdir()` reads `TMPDIR` on each
call, and child processes inherit it, so every temp folder of the run lands inside the root. A
global `afterAll` in the preload removes the root after the last test file.

- `bun test` (1.3) emits no process `exit` or `beforeExit` event, so an exit handler does not run.
  A preload-level `afterAll` runs once, after every file.
- A run that is killed leaves its one root. The disk-cleanup `/tmp` rule removes it after 7 days.

## Rejected alternatives

- **Add cleanup to each test (about 100 places).** It fixes today's leaks, but the next test that
  forgets `rmSync` leaks again. A rule in one place cannot be forgotten.
- **A shared `makeTempDir()` helper that tracks and removes folders.** It needs the same 100 edits,
  and it misses folders that child processes and libraries make with `tmpdir()`.
- **A shorter `/tmp` age in the disk-cleanup kit.** It treats the symptom and could delete temp
  files that running dev processes still use.
