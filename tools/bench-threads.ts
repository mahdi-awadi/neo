// Time the console's history reads (ADR-0017, AC3.6) on a synthetic in-memory ledger: the first page
// of the thread list (no filter, by project, by state), one thread page and a search. The budget is
// 300 ms server time for the Threads view's first paint; the test suite asserts the query plans
// (`_explain`), this prints the timings.
//
//   bun run tools/bench-threads.ts [messages=50000] [threads=5000]
//
// In memory only — it never opens the daemon's ledger.
import { openLedger } from "../src/engine/ledger";

const messages = Number(process.argv[2] ?? 50_000);
const threads = Number(process.argv[3] ?? 5_000);
const projects = ["gold", "waselni", "eticket", "neo", "adminli", "company"];
const states = ["open", "waiting", "done", "failed"] as const;

const l = openLedger(":memory:");
const roots: number[] = [];
const t0 = performance.now();
for (let i = 0; i < threads; i++) {
  const project = projects[i % projects.length]!;
  const id = l.insertMessage({ chatId: 1, role: "user", content: `order ${i} for ${project}: fix the fare list`, at: i * 1000, project });
  l.insertThread({ id, origin: "operator", title: `order ${i}`, state: states[i % states.length]!, createdAt: i * 1000, project });
  l.setMessageThread(id, id);
  roots.push(id);
}
for (let i = threads; i < messages; i++) {
  const root = roots[i % roots.length]!;
  const id = l.insertMessage({ chatId: 1, role: "assistant", content: `progress line ${i} تذكرة الطيران`, at: i * 1000, threadId: root });
  l.touchThread(root, id, i * 1000);
}
console.log(`seeded ${messages} messages in ${threads} threads in ${Math.round(performance.now() - t0)} ms`);

function time(label: string, fn: () => unknown): void {
  fn(); // warm the statement cache, as the daemon's would be
  const s = performance.now();
  const n = 20;
  for (let i = 0; i < n; i++) fn();
  console.log(`${label.padEnd(34)} ${((performance.now() - s) / n).toFixed(2)} ms`);
}

time("threads: first page (50)", () => l.listThreads({}, { limit: 50 }));
time("threads: project=gold (50)", () => l.listThreads({ project: "gold" }, { limit: 50 }));
time("threads: state=waiting (50)", () => l.listThreads({ state: "waiting" }, { limit: 50 }));
time("thread: one page of messages (50)", () => l.messagesInThread(roots[0]!, { limit: 50 }));
time("search: 'fare' (50)", () => l.searchMessages("fare", { limit: 50 }));
time("search: Arabic 'تذكرة' (50)", () => l.searchMessages("تذكرة", { limit: 50 }));
