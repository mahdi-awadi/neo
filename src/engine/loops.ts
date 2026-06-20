// The /loop command: a registry of named, verifiable loops the operator can fire (and later
// schedule). Each loop bundles a project folder, the worker prompt, and a verifiable goal
// command. /loop lists them; /loop <project> <goal> starts one in the background, streaming
// progress + the final outcome. The work runs through runProjectLoop, so it's governed and
// escalation-auto-denied (never pushes/deploys). See docs/loops.md.
import { runProjectLoop } from "./project-loop";
import type { GoalCheck } from "./goal";
import type { LoopOutcome } from "./loop-runner";
import type { runOrder } from "./session-runner";

export interface LoopDef {
  name: string; // canonical key, e.g. "gold-gofmt"
  usage: string; // "/loop gold gofmt"
  summary: string;
  folder: string; // where the worker opens
  prompt: string; // what the worker attempts each iteration
  goalCommand: string[]; // verifiable goal — exits 0 when done
  maxIterations: number;
  timeoutMs?: number;
}

export interface LoopDeps {
  reply: (chatId: number, text: string) => void | Promise<void>;
  /** Injectable worker runner (tests); defaults to the real session-runner. */
  run?: typeof runOrder;
  /** Injectable goal (tests); defaults to the loop's commandGoal. */
  check?: GoalCheck;
  now?: () => number;
}

const GOLD_GOFMT: LoopDef = {
  name: "gold-gofmt",
  usage: "/loop gold gofmt",
  summary: "format gold/server with gofmt and commit (never pushes)",
  folder: "/home/gold",
  prompt:
    "Run `gofmt -w server/` to fix Go formatting across the server module, then confirm `gofmt -l server/` prints nothing. Commit the formatting changes with a message like 'style: gofmt'. Do NOT push.",
  // met when no .go files under server/ need formatting
  goalCommand: ["sh", "-c", 'test -z "$(gofmt -l server/)"'],
  maxIterations: 3,
  timeoutMs: 60000,
};

export const LOOPS: LoopDef[] = [GOLD_GOFMT];

export function matchLoop(args: string): LoopDef | undefined {
  const key = args.trim().toLowerCase().replace(/\s+/g, "-");
  return LOOPS.find((l) => l.name === key);
}

function formatLoops(): string {
  return ["Available loops:", ...LOOPS.map((l) => `${l.usage} — ${l.summary}`)].join("\n");
}

/** Run a loop end to end, streaming progress and a final outcome line to the channel. */
export async function startLoop(loop: LoopDef, chatId: number, deps: LoopDeps): Promise<LoopOutcome> {
  await deps.reply(chatId, `🔁 ${loop.name}: starting on ${loop.folder}…`);
  const out = await runProjectLoop(
    {
      folder: loop.folder,
      prompt: loop.prompt,
      goalCommand: loop.goalCommand,
      maxIterations: loop.maxIterations,
      timeoutMs: loop.timeoutMs,
      onProgress: (m) => void deps.reply(chatId, m.length > 220 ? `${m.slice(0, 220)}…` : m),
    },
    { run: deps.run, check: deps.check },
  );
  await deps.reply(
    chatId,
    `🔁 ${loop.name}: ${out.met ? "✅ goal met" : `⚠️ ${out.reason}`} after ${out.iterations} iteration(s) — ${out.lastDetail}`,
  );
  return out;
}

/** Parse + dispatch a /loop command. Returns true if it was a /loop (handled), else false. */
export function handleLoop(text: string, chatId: number, deps: LoopDeps): boolean {
  const t = text.trim();
  if (t !== "/loop" && !t.startsWith("/loop ")) return false;
  const args = t.slice("/loop".length).trim();
  if (!args) {
    void deps.reply(chatId, formatLoops());
    return true;
  }
  const loop = matchLoop(args);
  if (!loop) {
    void deps.reply(chatId, `No loop "${args}".\n\n${formatLoops()}`);
    return true;
  }
  void startLoop(loop, chatId, deps); // background; streams via deps.reply
  return true;
}
