// ADR-0067, spec "Events and attention items", AC22 (plan task 17): the engine producer raises
// `history_off` (needs you: meaning search cannot start without the operator, and the item names the step),
// `history_degraded` (housekeeping: a service down or slow longer than `degradedAlertMinutes`) and
// `backup_failed` (needs you, while a backup job's failure streak lasts). Each item resolves itself when its
// condition ends. An in-memory ledger, a fake clock, the real backup schedule with a fake child.
import { expect, test } from "bun:test";
import { openLedger } from "../src/engine/ledger";
import { createRegistry } from "../src/engine/registry";
import { listOpen } from "../src/engine/attention";
import { engineDrafts, readAttentionCfg, runEngineProducer, type EngineProducerDeps } from "../src/engine/producers/engine";
import { attentionClass } from "../src/engine/needs-you";
import { explainAttention, whyEn } from "../src/engine/attention-explain";
import { attentionBrief } from "../src/engine/attention-briefs";
import { CODED_FACTS, factsOf } from "../src/engine/attention-facts";
import { HISTORY_DEFAULTS } from "../src/engine/history/defaults";
import type { MeaningOffReason } from "../src/engine/history/services";
import type { ServiceReport } from "../src/engine/history/indexer";
import { BACKUP_DEFAULTS } from "../src/engine/backup/cfg";
import { createBackupSchedule, type BackupState, type ChildRun } from "../src/engine/backup/schedule";
import { createConsoleI18n } from "../src/frontends/web/i18n";

const MIN = 60_000;
const T0 = 1_000 * 3_600_000;
const NEO = "/home/neo";
const UP: ServiceReport = { state: "up", since: 0 };

function setup() {
  const ledger = openLedger(":memory:");
  let services: { embedder: ServiceReport; vectors: ServiceReport } | undefined;
  let backup: BackupState = { failing: [], lastOk: {} };
  const deps: EngineProducerDeps = {
    ledger,
    registry: createRegistry(),
    cfg: { ...readAttentionCfg(undefined), approvalRemindMs: 30 * MIN, companyFolder: "/home/neo/agent" },
    neoFolder: NEO,
    history: { cfg: HISTORY_DEFAULTS, services: () => services },
    backups: () => backup,
  };
  return {
    ledger,
    deps,
    set: (s: typeof services) => (services = s),
    setBackup: (b: BackupState) => (backup = b),
  };
}

const OFF: Array<[keyof ReturnType<typeof services>, MeaningOffReason, RegExp]> = [
  ["embedder", "not_configured", /bun tools\/history\/install\.ts.*HISTORY_EMBEDDER_KEY/],
  ["embedder", "config_refused", /loopback/],
  ["embedder", "embedder_refused", /bun tools\/history\/install\.ts/],
  ["embedder", "embedder_wrong_model", /BAAI\/bge-m3/],
  ["vectors", "not_configured", /SHARED_QDRANT_URL.*SHARED_QDRANT_API_KEY/],
  ["vectors", "config_refused", /neo_history/],
  ["vectors", "vectors_refused", /reload Neo/],
  ["vectors", "collection_missing", /neo_history \(1024 dims, cosine\)/],
  ["vectors", "vectors_key_rejected", /reissue SHARED_QDRANT_API_KEY for neo_history.*reload/],
];
function services() {
  return { embedder: UP, vectors: UP };
}

test("each off reason gives history_off on its service, filed under Neo, with the step to take", () => {
  for (const [service, reason, step] of OFF) {
    const h = setup();
    h.set({ ...services(), [service]: { state: "off", since: T0, reason } });
    const drafts = engineDrafts(h.deps, T0 + MIN);
    expect(drafts.map((d) => d.kind), `${service}:${reason}`).toEqual(["history_off"]);
    const d = drafts[0]!;
    expect(d).toMatchObject({ project: "neo", folder: NEO, source: "engine", key: service, severity: "high" });
    expect(d.facts).toMatchObject({ service, reason, since: T0 });
    expect(String(d.facts!.step), `${service}:${reason}`).toMatch(step);
    // An off state is reported at once: it never comes back by itself.
    expect(d.title).toContain(reason);
  }
});

test("only the two services are read: other fields of what the seam hands over are never items", () => {
  const h = setup();
  const off: ServiceReport = { state: "off", since: T0, reason: "not_configured" };
  // As a whole pass report would hand them over (it has more fields, some with a `state`).
  h.set({ ...services(), reconcile: off, feed: off } as never);
  expect(engineDrafts(h.deps, T0 + MIN)).toEqual([]);
});

test("history_degraded comes only after degradedAlertMinutes, for each down service", () => {
  const h = setup();
  const minutes = HISTORY_DEFAULTS.degradedAlertMinutes;
  h.set({ embedder: { state: "down", since: T0, reason: "embedder_down" }, vectors: { state: "down", since: T0, reason: "vectors_slow" } });
  expect(engineDrafts(h.deps, T0 + (minutes - 1) * MIN)).toEqual([]);
  const drafts = engineDrafts(h.deps, T0 + minutes * MIN);
  expect(drafts.map((d) => [d.kind, d.key, d.severity])).toEqual([["history_degraded", "embedder", "normal"], ["history_degraded", "vectors", "normal"]]);
  expect(drafts[0]!.facts).toMatchObject({ service: "embedder", reason: "embedder_down", since: T0 });
  expect(String(drafts[0]!.facts!.step)).toContain("neo-embedder");
  // The limit comes from the config.
  h.deps.history = { cfg: { ...HISTORY_DEFAULTS, degradedAlertMinutes: 5 }, services: h.deps.history!.services };
  expect(engineDrafts(h.deps, T0 + 5 * MIN).length).toBe(2);
});

test("history items resolve themselves on recovery; no report yet keeps them; history off resolves them", () => {
  const h = setup();
  h.set({ embedder: { state: "off", since: T0, reason: "embedder_refused" }, vectors: { state: "down", since: T0, reason: "vectors_down" } });
  runEngineProducer(h.deps, T0 + 2 * 60 * MIN);
  expect(listOpen(h.ledger, { now: T0 + 2 * 60 * MIN }).map((r) => r.kind).sort()).toEqual(["history_degraded", "history_off"]);
  // Before the first pass after a restart there is no report: nothing is resolved by mistake.
  h.set(undefined);
  runEngineProducer(h.deps, T0 + 3 * 60 * MIN);
  expect(listOpen(h.ledger, { now: T0 + 3 * 60 * MIN }).length).toBe(2);
  // Recovery: both services up → both items resolve.
  h.set({ embedder: UP, vectors: UP });
  const r = runEngineProducer(h.deps, T0 + 4 * 60 * MIN);
  expect(r.resolved.length).toBe(2);
  expect(listOpen(h.ledger, { now: T0 + 4 * 60 * MIN })).toEqual([]);
  // History turned off in the config: no seam, so an old item resolves too.
  h.set({ embedder: { state: "off", since: T0, reason: "not_configured" }, vectors: UP });
  runEngineProducer(h.deps, T0 + 5 * 60 * MIN);
  expect(listOpen(h.ledger, { now: T0 + 5 * 60 * MIN }).length).toBe(1);
  delete h.deps.history;
  runEngineProducer(h.deps, T0 + 6 * 60 * MIN);
  expect(listOpen(h.ledger, { now: T0 + 6 * 60 * MIN })).toEqual([]);
});

test("backup_failed: the real schedule's failure streak opens the item with its path and reason; a success resolves it", async () => {
  const h = setup();
  const runs: ChildRun[] = [
    { code: 1, stdout: "", stderr: "backup_failed low_space 3.0 GiB free, need 20 GiB\n", timedOut: false },
    { code: 0, stdout: JSON.stringify({ ok: true, manifest: { counts: { a: 1 } }, deleted: [] }) + "\n", stderr: "", timedOut: false },
  ];
  let now = new Date(2026, 9, 30, 3, 40, 0).getTime();
  const schedule = createBackupSchedule({
    cfg: { ...BACKUP_DEFAULTS, dir: "/tmp/neo-backup-test-unused" }, baseDir: NEO, bun: "bun", now: () => now,
    events: () => {}, alert: () => {}, spawn: async () => runs.shift()!,
  });
  h.deps.backups = () => schedule.state();
  now += 2 * MIN;
  await schedule.tick();
  runEngineProducer(h.deps, now);
  const [item] = listOpen(h.ledger, { now });
  expect(item).toMatchObject({ kind: "backup_failed", key: "snapshot:history", project: "neo", severity: "high" });
  expect(item!.facts).toMatchObject({ path: "data/history.db", code: "low_space", reason: "low_space: 3.0 GiB free, need 20 GiB", since: now });
  expect(explainAttention(item!).reasonOk).toBe(true);
  expect(whyEn(explainAttention(item!), now)).toBe("The snapshot backup of data/history.db failed: low_space: 3.0 GiB free, need 20 GiB.");
  // The next day's slot succeeds: the item resolves.
  now += 24 * 60 * MIN;
  await schedule.tick();
  runEngineProducer(h.deps, now);
  expect(listOpen(h.ledger, { now })).toEqual([]);
});

test("a failing restore drill names the backup folder", () => {
  const h = setup();
  h.setBackup({ failing: [{ job: "drill", kind: "drill", path: "/var/backups/neo", since: T0, at: T0, code: "count_mismatch", reason: "history history-x.db.gz", streak: 1 }], lastOk: {} });
  const [d] = engineDrafts(h.deps, T0 + MIN);
  expect(d).toMatchObject({ kind: "backup_failed", key: "drill", title: "restore drill of /var/backups/neo failed: count_mismatch" });
  expect(d!.facts).toMatchObject({ path: "/var/backups/neo", reason: "restore drill, count_mismatch: history history-x.db.gz" });
});

test("classes: history_off and backup_failed need the operator; history_degraded is housekeeping", () => {
  expect(attentionClass("history_off")).toBe("needs_you");
  expect(attentionClass("backup_failed")).toBe("needs_you");
  expect(attentionClass("history_degraded")).toBe("housekeeping");
});

test("explain: the bold line is the step, the reason reads from the history.reason catalogue, the brief names the step", () => {
  const h = setup();
  h.set({ embedder: { state: "off", since: T0, reason: "embedder_refused" }, vectors: UP });
  runEngineProducer(h.deps, T0 + MIN);
  const [row] = listOpen(h.ledger, { now: T0 + MIN });
  const e = explainAttention(row!);
  expect(e.badge).toBe("history_off");
  expect(e.plain).toContain("bun tools/history/install.ts");
  expect(e.reasonOk).toBe(true);
  expect(whyEn(e, T0 + MIN)).toBe("Meaning search over the task history is off: the embedder refused the key. Only word and id matches work.");
  expect(e.brief).toContain("bun tools/history/install.ts");
  for (const kind of ["history_off", "history_degraded", "backup_failed"]) expect(attentionBrief({ kind, title: "x", project: "neo" })).toContain("Done when:");
  // The console translates the same code in both languages.
  expect(CODED_FACTS.history_off).toEqual({ reason: "history.reason" });
  expect(CODED_FACTS.history_degraded).toEqual({ reason: "history.reason" });
  for (const lang of ["en", "ar"] as const) {
    const i = createConsoleI18n(lang);
    for (const kind of ["history_off", "history_degraded", "backup_failed"]) for (const part of ["kind", "why", "next"]) expect(i.exists(`att.${part}.${kind}`), `${lang}:${part}:${kind}`).toBe(true);
    for (const [, reason] of OFF) expect(i.exists(`history.reason.${reason}`), `${lang}:${reason}`).toBe(true);
  }
});

test("an older row gets its facts from its key and title", () => {
  expect(factsOf({ kind: "history_off", key: "vectors", title: "history search off (vectors): collection_missing" })).toEqual({ service: "vectors", reason: "collection_missing" });
  expect(factsOf({ kind: "history_degraded", key: "embedder", title: "history embedder down 2h: embedder_slow" })).toEqual({ service: "embedder", reason: "embedder_slow" });
  expect(factsOf({ kind: "backup_failed", key: "snapshot:history", title: "snapshot backup of data/history.db failed: low_space" })).toEqual({ path: "data/history.db", code: "low_space" });
});
