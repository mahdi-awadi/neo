// A task-history test bench (ADR-0066): an in-memory ledger, a temp `history.db`, the fake TEI and the fake
// Qdrant on 127.0.0.1 (port 0), the real adapters pointed at them, and an event recorder. Used by the
// indexer, search and remember/forget tests. Nothing here reaches a real service.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, type Ledger, type NewTodo } from "../../src/engine/ledger";
import { SUB_CHAT } from "../../src/engine/chats";
import { EMBEDDER_DEFAULTS, HISTORY_DEFAULTS, VECTORS_DEFAULTS, type HistoryCfg } from "../../src/engine/history/defaults";
import { openEmbedder, type Embedder } from "../../src/engine/history/embedder";
import { openHistoryStore, type HistoryStore } from "../../src/engine/history/store";
import { openVectorIndex, type VectorIndex } from "../../src/engine/history/vector-index";
import type { Order } from "../../src/types";
import { startFakeQdrant, type FakeQdrant } from "./fake-qdrant";
import { startFakeTei, type FakeTei } from "./fake-tei";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A JWT-shaped Qdrant key for `neo_history`; the signature holds a marker so a leak is easy to find. */
export const QDRANT_KEY = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ access: [{ collection: "neo_history", access: "rw" }] })}.MARKERqdrant${"x".repeat(20)}`;
export const TEI_KEY = "MARKER-fake-tei-test-token";
export const REV = "5617a9f61b028005a4858fdac845db406aefb181";
export const REV2 = "aaaabbbbccccddddeeeeffff0000111122223333";
export const DIMS = 4;

export interface Bench {
  led: Ledger;
  store: HistoryStore;
  dbPath: string;
  tei: FakeTei;
  qdrant: FakeQdrant;
  embedder: Embedder;
  vectors: VectorIndex;
  cfg: HistoryCfg;
  env: Record<string, string>;
  workRoot: string;
  events: Array<{ kind: string; data: Record<string, unknown> }>;
  record: (kind: string, data: Record<string, unknown>) => void;
  embedCalls(): number;
  embedInputs(): string[];
  stop(): void;
}

export function bench(opts: { vectorOf?: (text: string) => number[]; cfg?: (c: HistoryCfg) => HistoryCfg; dbPath?: string } = {}): Bench {
  const tei = startFakeTei({ key: TEI_KEY, revision: REV, dims: DIMS, ...(opts.vectorOf ? { vectorOf: opts.vectorOf } : {}) });
  const qdrant = startFakeQdrant({ key: QDRANT_KEY, collections: { neo_history: DIMS } });
  const base: HistoryCfg = {
    ...HISTORY_DEFAULTS,
    embedder: { ...EMBEDDER_DEFAULTS, url: tei.url, revision: REV, dims: DIMS },
    vectors: { ...VECTORS_DEFAULTS },
  };
  const cfg = opts.cfg ? opts.cfg(base) : base;
  const env = { HISTORY_EMBEDDER_KEY: TEI_KEY, SHARED_QDRANT_URL: qdrant.url, SHARED_QDRANT_API_KEY: QDRANT_KEY };
  const dbPath = opts.dbPath ?? join(mkdtempSync(join(tmpdir(), "neo-hist-bench-")), "history.db");
  const store = openHistoryStore(dbPath);
  const events: Bench["events"] = [];
  return {
    led: openLedger(":memory:"),
    store,
    dbPath,
    tei,
    qdrant,
    embedder: openEmbedder(cfg.embedder, env),
    vectors: openVectorIndex(cfg.vectors, env, { dims: cfg.embedder.dims }),
    cfg,
    env,
    workRoot: tmpdir(),
    events,
    record: (kind, data) => void events.push({ kind, data }),
    embedCalls: () => tei.requests.filter((r) => r.path === "/embed").length,
    embedInputs: () => tei.requests.flatMap((r) => (r.path === "/embed" ? (r.inputs ?? []) : [])),
    stop() {
      try {
        store.close();
      } catch {
        // already closed by the test
      }
      tei.stop();
      qdrant.stop();
    },
  };
}

export const order = (over: Partial<Order> = {}): Order => ({ id: "o1", source: "neo", folder: "/home/eticket", task: "t", chatId: SUB_CHAT, createdAt: 1000, ...over });
export const todo = (over: Partial<NewTodo> = {}): NewTodo => ({ project: "eticket", folder: "/home/eticket", brief: "b", workClass: "interactive", createdBy: "operator", ...over });

/** An operator thread in `project` (a todo on it is placed by the firewall). */
export function operatorThread(led: Ledger, project = "eticket", origin: "operator" | "ingress" = "operator"): number {
  const t = led.insertMessage({ chatId: 1, role: "user", content: "go ahead with it", at: 1, surface: "telegram", project });
  led.setMessageThread(t, t);
  led.insertThread({ id: t, origin, title: "go", state: "open", createdAt: 1, project, folder: `/home/${project}` });
  return t;
}

/** Points the fake Qdrant holds for a model tag. */
export function remotePoints(q: FakeQdrant, tag: string): string[] {
  return [...(q.collections.get("neo_history")?.points.values() ?? [])].filter((p) => p.payload.m === tag).map((p) => p.id);
}
