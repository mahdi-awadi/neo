// A local console with seeded needs-you items, for mobile UI checks and the mobile e2e test (ADR-0071): the
// real web app over an in-memory ledger and a fake worker — nothing runs, nothing reaches Telegram or the
// subscription. It binds 127.0.0.1 only; its login URL is signed with a throwaway bot token.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createWebApp } from "../../src/frontends/web";
import { loadConfig } from "../../src/config";
import { openLedger } from "../../src/engine/ledger";
import { openAdminStore } from "../../src/engine/admin";
import { createRegistry } from "../../src/engine/registry";
import { createMeter } from "../../src/engine/budget";
import { createSessionStore } from "../../src/engine/web-session";
import { openTrustStore } from "../../src/engine/trust";
import { createTrace } from "../../src/engine/trace";
import type { RunResult, SessionRun } from "../../src/engine/session-runner";

export interface ConsoleDemo {
  /** The one-time login URL (it sets the session cookie, then redirects to the console). */
  loginUrl: string;
  port: number;
  ledger: ReturnType<typeof openLedger>;
  /** The seeded items: the hidden decision behind the stale reminder, the options decision, the plan card. */
  ids: { hidden: string; options: string; card: string; planId: number };
  stop(): void;
}

/** Start the demo console on `port` (0 = any free port). */
export function startConsoleDemo(port = 0): ConsoleDemo {
  const token = `0:${randomBytes(16).toString("hex")}`; // throwaway: it signs only this demo's login
  const work = mkdtempSync(join(tmpdir(), "neo-console-demo-"));
  const project = join(work, "neo");
  mkdirSync(join(project, "docs", "superpowers", "plans"), { recursive: true });
  const planPath = "docs/superpowers/plans/2026-10-30-browser-memory.md";
  writeFileSync(
    join(project, planPath),
    [
      "# Plan: cut the memory each worker uses for browser tools",
      "",
      "**Goal:** one shared browser per host instead of one per worker.",
      "",
      "## Tasks",
      "",
      "1. Measure the memory of each browser MCP process (`ps -o rss`).",
      "2. Route every worker to the shared browser (ADR-0032).",
      "3. Cap it with `--max-old-space-size` and a cgroup limit.",
      "",
      "| Step | Before | After |",
      "| --- | ---: | ---: |",
      "| one worker | 450 MB | 0 MB |",
      "| ten workers | 4.5 GB | 600 MB |",
      "",
      "```bash",
      "bun tools/browser/install.ts",
      "```",
      "",
      "<script>alert('raw html is shown as text')</script>",
      "",
      "## Appendix: measurements",
      "",
      ...Array.from({ length: 60 }, (_, i) => `- worker ${i + 1}: 450 MB resident, 1 browser`),
    ].join("\n"),
  );

  const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "neo-console-demo-cfg-"))), telegramToken: token, workRoot: work, mdFiles: { roots: [work], maxBytes: 2 * 1024 * 1024, viewMaxBytes: 256 * 1024 } };
  const ledger = openLedger(":memory:");
  const registry = createRegistry();
  const trace = createTrace({ ledger, registry });
  const now = Date.now();

  // The live case: a decision the operator hid, and its "open 24h" reminder.
  const hidden = ledger.openDecision({ kind: "decision", question: "Should I write a plan to cut the memory each Neo worker uses for browser tools?", folder: project, project: "neo", orderId: crypto.randomUUID() }, now - 26 * 3_600_000);
  ledger.setPin(`dec:${hidden}`, "unpinned", now - 25 * 3_600_000);
  ledger.insertAttention(
    { project: "neo", folder: project, source: "engine", kind: "decision_stale", key: hidden, title: `decision open 1d: Should I write a plan to cut the memory each Neo worker uses for browser tools?`, severity: "high", facts: { decision: hidden.slice(0, 8), question: "Should I write a plan to cut the memory each Neo worker uses for browser tools?", since: now - 26 * 3_600_000 } },
    now - 2 * 3_600_000,
  );
  // A decision with options, and a plan waiting for approval.
  const options = ledger.openDecision({ kind: "decision", question: "Which payment provider should eticket use for refunds?", options: ["Qi Card", "ZainCash", "Both"], folder: project, project: "eticket-v3", orderId: crypto.randomUUID() }, now - 3_600_000);
  const card = ledger.openDecision({ kind: "decision", question: `Plan waiting for your approval: ${planPath} — Cut browser memory`, folder: project, project: "neo" }, now - 600_000);
  const plan = ledger.upsertPlan({ project: "neo", folder: project, path: planPath, title: "Cut browser memory", sha256: "demo", stepsTotal: 3, stepsDone: 0, status: "sent", gate: "approval", version: 1, decisionId: card } as never);

  const never = new Promise<RunResult>(() => {});
  const start = (): SessionRun => ({ followUp: () => {}, interrupt: async () => {}, queued: () => 0, active: () => false, close: () => {}, closed: () => false, done: never });
  const admin = openAdminStore(":memory:");
  const app = createWebApp({
    engine: { cfg, ledger, registry, meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }), trust: openTrustStore(":memory:"), start, trace },
    botToken: token,
    botUsername: "neo_demo_bot",
    sessions: createSessionStore({ secret: randomBytes(32).toString("hex"), ttlSec: 3600 }),
    admin,
  });

  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (req) => app.fetch(req) });
  // A Telegram-login URL signed with the throwaway token (the console's real login path).
  const data: Record<string, string> = { id: "555", auth_date: String(Math.floor(Date.now() / 1000)) };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  data.hash = createHmac("sha256", createHash("sha256").update(token).digest()).update(dcs).digest("hex");
  return {
    loginUrl: `http://127.0.0.1:${server.port}/auth/telegram?${new URLSearchParams(data)}`,
    port: server.port!,
    ledger,
    ids: { hidden, options, card, planId: plan.id },
    stop: () => server.stop(true),
  };
}
