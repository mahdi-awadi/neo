// The `project_notes` worker tool (ADR-0043): a thin adapter over ProjectNotes, attached only where
// `deps.notes` is wired — never on the customer/ingress path (AC18).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { neoMcpServers, type DispatchDeps } from "../src/engine/dispatch";
import { createProjectNotes, DEFAULT_NOTES_CFG } from "../src/engine/project-notes";
import { runCompanyBrief } from "../src/engine/ingress";
import { registerDefaultProject } from "../src/engine/default-project";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
const neoTools = (servers: Record<string, unknown>) =>
  (servers.neo as { instance: { _registeredTools: Record<string, { handler: Handler; inputSchema?: unknown }> } }).instance._registeredTools;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "neo-notes-tool-"));
  for (const p of ["prod-ops", "eticket-v3"]) mkdirSync(join(root, p));
  const ledger = openLedger(":memory:");
  const notes = createProjectNotes({ ledger, cfg: DEFAULT_NOTES_CFG, workRoot: root, desksDir: join(root, "no-desks") });
  const d: DispatchDeps = {
    ledger,
    registry: createRegistry(),
    meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
    trust: openTrustStore(":memory:"),
    reply: () => {},
    askApproval: async () => "deny",
    notes,
  };
  return { root, ledger, d };
}

test("project_notes attaches only when deps.notes is wired", () => {
  const { root, d } = setup();
  const folder = join(root, "prod-ops");
  expect(Object.keys(neoTools(neoMcpServers(d, 1, { dispatch: false, folder, projectName: "prod-ops" })))).toContain("project_notes");
  expect(Object.keys(neoTools(neoMcpServers({ ...d, notes: undefined }, 1, { dispatch: false, folder })))).not.toContain("project_notes");
});

test("send through the tool: the sender is the session's project and the cause is the call's", async () => {
  const { root, ledger, d } = setup();
  const tools = neoTools(
    neoMcpServers(d, 9, { dispatch: false, folder: join(root, "prod-ops"), projectName: "prod-ops", cause: () => ({ msgId: 5, threadId: 4 }) }),
  );
  const out = await tools.project_notes!.handler(
    { action: "send", to: "eticket-v3", kind: "finding", severity: "normal", ref: "D16", title: "stale pnr", body: "b", refs: ["x"], from: "someone-else" },
    {},
  );
  expect(out.content[0]?.text).toMatch(/^note #\d+ → eticket-v3$/);
  expect(ledger.attentionRows("eticket-v3", "note")[0]).toMatchObject({ fromProject: "prod-ops", causeMsgId: 5, key: "prod-ops:D16" });
});

test("the tool's input has no sender field: a worker cannot name or fake the sender", () => {
  const { root, d } = setup();
  const t = neoTools(neoMcpServers(d, 1, { dispatch: false, folder: join(root, "prod-ops"), projectName: "prod-ops" })).project_notes!;
  const fields = Object.keys((JSON.parse(JSON.stringify(t.inputSchema)) as { def: { shape: Record<string, unknown> } }).def.shape);
  expect(fields).toContain("to");
  for (const f of ["from", "sender", "fromProject", "project"]) expect(fields).not.toContain(f);
});

test("send with a missing field says what is missing and stores nothing", async () => {
  const { root, ledger, d } = setup();
  const t = neoTools(neoMcpServers(d, 1, { dispatch: false, folder: join(root, "prod-ops"), projectName: "prod-ops" })).project_notes!;
  const out = await t.handler({ action: "send", to: "eticket-v3", kind: "finding" }, {});
  expect(out.content[0]?.text).toMatch(/send needs/);
  expect(ledger.attentionRows("eticket-v3", "note")).toEqual([]);
});

// AC18: the customer/ingress path spreads the operator's deps; it must strip notes explicitly.
test("a customer (ingress) brief never gets project_notes, even when the operator deps carry notes", async () => {
  const { d } = setup();
  registerDefaultProject(d.registry, d.ledger, undefined, () => 1);
  let seen: { mcpServers?: Record<string, unknown> } | undefined;
  const fakeRun = async (_o: Order, _h: RunHandlers, x?: { mcpServers?: Record<string, unknown> }): Promise<RunResult> => {
    seen = x;
    return { ok: true, sessionId: "co-1", summary: "ok", costUsd: 0 };
  };
  await runCompanyBrief("customer asks about a booking", { ...d, cfg: { workers: {}, workerEnv: {} } as never, run: fakeRun as never, now: () => 2 });
  expect(seen?.mcpServers).toBeDefined();
  expect(Object.keys(neoTools(seen!.mcpServers!))).not.toContain("project_notes");
});

test("the tool's read and close actions: list, show, ack, resolve, withdraw", async () => {
  const { root, d } = setup();
  const sender = neoTools(neoMcpServers(d, 1, { dispatch: false, folder: join(root, "prod-ops"), projectName: "prod-ops" })).project_notes!;
  const target = neoTools(neoMcpServers(d, 1, { dispatch: false, folder: join(root, "eticket-v3"), projectName: "eticket-v3" })).project_notes!;
  const text = async (t: typeof sender, args: Record<string, unknown>) => (await t.handler(args, {})).content[0]?.text ?? "";
  const sent = await text(sender, { action: "send", to: "eticket-v3", kind: "fyi", severity: "low", ref: "n1", title: "heads up", body: "the body" });
  const id = Number(sent.match(/#(\d+)/)![1]);
  expect(await text(target, { action: "list" })).toContain(`#${id} [fyi/low] from prod-ops: heads up`);
  expect(await text(target, { action: "show", id })).toContain("the body");
  expect(await text(target, { action: "ack", id })).toBe(`note #${id} acknowledged`);
  expect(await text(target, { action: "resolve", id, how: "not_needed", reason: "already known" })).toMatch(/resolved \(not_needed\)/);
  expect(await text(sender, { action: "list", box: "from" })).toContain(`#${id} → eticket-v3: heads up — not needed: already known`);
  expect(await text(sender, { action: "withdraw", id })).toMatch(/already not_needed/);
  expect(await text(target, { action: "show" })).toMatch(/needs `id`/);
});
