// Author an operator-authored project loop from the command line, through the SAME validated path
// the admin web console uses: validateLoopInput (name/folder fence/goal/trigger/bounds) → createLoop
// → the ledger's `loop_defs` table. No hand-written SQL, so a loop written here is governed by
// exactly the rules a loop written from the console is.
//
// Why it exists: /api/loop/{create,update,...} is admin-session-gated, so an agent working inside
// this repo on the operator's behalf cannot author a loop through the web CRUD. This is the same
// engine, one door down — not a second implementation of it.
//
// The daemon re-reads `loop_defs` on EVERY scheduler tick (daemon.ts's `effectiveLoops(ledger)`),
// so a loop created here is picked up with NO restart and no reload.
//
//   bun run tools/create-loop.ts <input.json> [--update] [--ledger <path>]
//
// <input.json> is one LoopInput object (see src/engine/loop-validate.ts). `--update` edits an
// existing custom loop in place instead of refusing the name; `--ledger` points at a different DB
// (tests) and defaults to the daemon's own.
//
// A loop's prompt is a STANDING BRIEF (docs/adr/0004): the engine never wraps it, so it carries the
// project's rules, the engineering baseline and the governance envelope itself, and it is long. To
// keep it reviewable and diffable rather than buried in one JSON string, the input may set
// `promptFile` (a path relative to the input file) INSTEAD of `prompt` — one source of truth, not
// two.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LEDGER_PATH, openLedger } from "../src/engine/ledger";
import { createLoop, updateLoop, type LoopDef } from "../src/engine/loops";
import type { LoopInput } from "../src/engine/loop-validate";

export interface ToolArgs {
  file: string;
  ledgerPath: string;
  update: boolean;
}

const USAGE = "usage: bun run tools/create-loop.ts <input.json> [--update] [--ledger <path>]";

export function parseArgs(argv: string[]): ToolArgs | { error: string } {
  let file: string | undefined;
  let ledgerPath = LEDGER_PATH;
  let update = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update") update = true;
    else if (a === "--ledger") {
      const v = argv[++i];
      if (!v) return { error: `--ledger needs a path. ${USAGE}` };
      ledgerPath = v;
    } else if (a.startsWith("--")) return { error: `unknown flag ${a}. ${USAGE}` };
    else if (file === undefined) file = a;
    else return { error: `unexpected argument ${a}. ${USAGE}` };
  }
  if (!file) return { error: USAGE };
  return { file, ledgerPath, update };
}

export type ApplyResult = { ok: true; def: LoopDef } | { ok: false; error: string };

/** What the input file may hold: a LoopInput, with `prompt` optionally supplied out-of-line. */
type LoopInputFile = Omit<LoopInput, "prompt"> & { prompt?: string; promptFile?: string };

/** Read the LoopInput file and persist it through the engine's own create/update path. Every
 *  failure — unreadable file, bad JSON, an unreadable promptFile, or a validation refusal — comes
 *  back as `{ok:false}`; nothing here throws, so the CLI reports one clear line and exits non-zero. */
export function applyLoopFile(args: ToolArgs): ApplyResult {
  let raw: LoopInputFile;
  try {
    raw = JSON.parse(readFileSync(args.file, "utf-8")) as LoopInputFile;
  } catch (err) {
    return { ok: false, error: `cannot read ${args.file}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const { promptFile, ...rest } = raw;
  let input = rest as LoopInput;
  if (promptFile !== undefined) {
    // Two sources of truth for the same field is the bug this option exists to avoid — refuse it
    // rather than silently picking one.
    if (rest.prompt !== undefined) return { ok: false, error: "set prompt or promptFile, not both" };
    const path = resolve(dirname(args.file), promptFile);
    try {
      input = { ...rest, prompt: readFileSync(path, "utf-8").trim() };
    } catch (err) {
      return { ok: false, error: `cannot read promptFile ${promptFile}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const ledger = openLedger(args.ledgerPath);
  return args.update ? updateLoop(input.name, input, ledger) : createLoop(input, ledger);
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exit(1);
  }
  const res = applyLoopFile(args);
  if (!res.ok) {
    console.error(`refused: ${res.error}`);
    process.exit(1);
  }
  console.log(JSON.stringify(res.def, null, 2));
  console.log(`\nstored in ${args.ledgerPath} — the scheduler picks it up on its next tick (no restart).`);
}
