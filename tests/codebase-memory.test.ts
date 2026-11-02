import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeIndexer, type CodebaseMemoryClient, type CmProject, type IndexStore } from "../src/engine/codebase-memory";

/** A fake codebase-memory: `index` adds the folder under a path-derived name, like the real binary. */
function mockClient(initial: CmProject[], opts: { failList?: boolean; failIndex?: boolean; indexMs?: number } = {}) {
  const projects = [...initial];
  const calls = { list: 0, index: [] as string[] };
  const client: CodebaseMemoryClient = {
    async listProjects() {
      calls.list++;
      if (opts.failList) throw new Error("list boom");
      return [...projects];
    },
    async indexRepository(p) {
      calls.index.push(p);
      if (opts.indexMs) await new Promise((r) => setTimeout(r, opts.indexMs));
      if (opts.failIndex) throw new Error("index boom");
      if (!projects.some((x) => x.root_path === p)) projects.push({ name: p.replace(/^\//, "").replace(/\//g, "-"), root_path: p });
    },
  };
  return { client, calls, projects };
}

function memStore(): IndexStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (f) => data.get(f), set: (f, v) => void data.set(f, v) };
}

const dir = () => mkdtempSync(join(tmpdir(), "cm-"));

test("an indexed folder at the same HEAD: no index, and the exact project name comes back", async () => {
  const d = dir();
  const { client, calls } = mockClient([{ name: "home-x", root_path: d }]);
  const store = memStore();
  store.set(d, "sha1");
  const ix = makeIndexer(client, { store, fingerprint: () => "sha1" });
  let fired = 0;
  expect(await ix.ensureIndexed(d, () => void fired++)).toEqual({ project: "home-x" });
  expect(calls.index).toEqual([]);
  expect(fired).toBe(0);
});

test("every dispatch checks again: an index lost after the first check is rebuilt (no forever cache)", async () => {
  const d = dir();
  const { client, calls, projects } = mockClient([{ name: "home-x", root_path: d }]);
  const store = memStore();
  store.set(d, "sha1");
  const ix = makeIndexer(client, { store, fingerprint: () => "sha1" });
  await ix.ensureIndexed(d);
  projects.splice(0); // the binary lost the DB (a crash mid-rebuild)
  let fired = 0;
  const r = await ix.ensureIndexed(d, () => void fired++);
  expect(calls.index).toEqual([d]);
  expect(fired).toBe(1);
  expect(r.project).toBeTruthy();
  expect(calls.list).toBe(3); // checked on each dispatch, and once more after indexing to read the name
});

test("a missing folder is indexed once, the name is read back, and its HEAD is recorded", async () => {
  const d = dir();
  const { client, calls } = mockClient([{ name: "other", root_path: "/somewhere/else" }]);
  const store = memStore();
  const ix = makeIndexer(client, { store, fingerprint: () => "abc" });
  let fired = 0;
  const r = await ix.ensureIndexed(d, () => void fired++);
  expect(calls.index).toEqual([d]);
  expect(fired).toBe(1);
  expect(r.project).toBe(d.replace(/^\//, "").replace(/\//g, "-"));
  expect(store.data.get(d)).toBe("abc");
});

test("a stale index (HEAD moved since the engine last indexed) is refreshed quietly", async () => {
  const d = dir();
  const { client, calls } = mockClient([{ name: "home-x", root_path: d }]);
  const store = memStore();
  store.set(d, "old");
  const ix = makeIndexer(client, { store, fingerprint: () => "new" });
  let fired = 0;
  expect(await ix.ensureIndexed(d, () => void fired++)).toEqual({ project: "home-x" });
  expect(calls.index).toEqual([d]);
  expect(fired).toBe(0); // a refresh is not a first index: no operator line
  expect(store.data.get(d)).toBe("new");
});

test("an indexed folder the engine has no record of is refreshed once, then recorded", async () => {
  const d = dir();
  const { client, calls } = mockClient([{ name: "home-x", root_path: d }]);
  const store = memStore();
  const ix = makeIndexer(client, { store, fingerprint: () => "h1" });
  await ix.ensureIndexed(d);
  await ix.ensureIndexed(d);
  expect(calls.index).toEqual([d]);
});

test("no freshness signal (not a git repo): indexed only when missing", async () => {
  const d = dir();
  const { client, calls } = mockClient([{ name: "home-x", root_path: d }]);
  const ix = makeIndexer(client, { store: memStore(), fingerprint: () => undefined });
  expect(await ix.ensureIndexed(d)).toEqual({ project: "home-x" });
  expect(calls.index).toEqual([]);
});

test("two dispatches to one folder at once share one index run", async () => {
  const d = dir();
  const { client, calls } = mockClient([], { indexMs: 20 });
  const ix = makeIndexer(client, { store: memStore(), fingerprint: () => "h" });
  const [a, b] = await Promise.all([ix.ensureIndexed(d), ix.ensureIndexed(d)]);
  expect(calls.index).toEqual([d]);
  expect(a.project).toBeTruthy();
  expect(b.project).toBe(a.project);
});

test("listProjects failure: resolves with no project (never throws), and the next dispatch tries again", async () => {
  const d = dir();
  const { client, calls } = mockClient([], { failList: true });
  const ix = makeIndexer(client, { store: memStore(), fingerprint: () => "h" });
  expect(await ix.ensureIndexed(d)).toEqual({});
  await ix.ensureIndexed(d);
  expect(calls.list).toBe(2);
  expect(calls.index).toEqual([]);
});

test("indexRepository failure: resolves with no project, records nothing, retries next time", async () => {
  const d = dir();
  const { client, calls } = mockClient([], { failIndex: true });
  const store = memStore();
  const ix = makeIndexer(client, { store, fingerprint: () => "h" });
  expect(await ix.ensureIndexed(d)).toEqual({});
  await ix.ensureIndexed(d);
  expect(calls.index).toEqual([d, d]);
  expect(store.data.size).toBe(0);
});

test("a failed refresh of an existing index still hands out the name (stale beats nothing)", async () => {
  const d = dir();
  const { client } = mockClient([{ name: "home-x", root_path: d }], { failIndex: true });
  const store = memStore();
  store.set(d, "old");
  const ix = makeIndexer(client, { store, fingerprint: () => "new" });
  expect(await ix.ensureIndexed(d)).toEqual({ project: "home-x" });
  expect(store.data.get(d)).toBe("old");
});

test("matching is trailing-slash insensitive", async () => {
  const d = dir();
  const { client, calls } = mockClient([{ name: "p", root_path: d + "/" }]);
  const ix = makeIndexer(client, { store: memStore(), fingerprint: () => undefined });
  expect(await ix.ensureIndexed(d)).toEqual({ project: "p" });
  expect(calls.index).toEqual([]);
});
