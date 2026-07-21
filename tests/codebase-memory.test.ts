import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeIndexer, type CodebaseMemoryClient, type CmProject } from "../src/engine/codebase-memory";

function mockClient(projects: CmProject[], opts: { failList?: boolean; failIndex?: boolean } = {}) {
  const calls = { list: 0, index: [] as string[] };
  const client: CodebaseMemoryClient = {
    async listProjects() {
      calls.list++;
      if (opts.failList) throw new Error("list boom");
      return projects;
    },
    async indexRepository(p) {
      calls.index.push(p);
      if (opts.failIndex) throw new Error("index boom");
    },
  };
  return { client, calls };
}

test("already-indexed folder: no index, no onFirstIndex, list once, then cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([{ name: "p", root_path: dir }]);
  const ix = makeIndexer(client);
  let fired = 0;
  await ix.ensureIndexed(dir, () => void fired++);
  await ix.ensureIndexed(dir, () => void fired++); // second call must be a cached no-op
  expect(calls.index.length).toBe(0);
  expect(fired).toBe(0);
  expect(calls.list).toBe(1); // cache hit on the second call → no extra list_projects
});

test("missing folder: indexRepository once + onFirstIndex once + cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([{ name: "other", root_path: "/somewhere/else" }]);
  const ix = makeIndexer(client);
  let fired = 0;
  await ix.ensureIndexed(dir, () => void fired++);
  await ix.ensureIndexed(dir, () => void fired++); // cached now
  expect(calls.index).toEqual([dir]);
  expect(fired).toBe(1);
  expect(calls.list).toBe(1);
});

test("listProjects failure: resolves (no throw), not cached (retries next time)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([], { failList: true });
  const ix = makeIndexer(client);
  await ix.ensureIndexed(dir); // must not throw
  await ix.ensureIndexed(dir);
  expect(calls.list).toBe(2); // not cached → tried again
  expect(calls.index.length).toBe(0);
});

test("indexRepository failure: resolves (no throw), not cached (retries next time)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([], { failIndex: true });
  const ix = makeIndexer(client);
  await ix.ensureIndexed(dir); // must not throw
  await ix.ensureIndexed(dir);
  expect(calls.index).toEqual([dir, dir]); // retried
});

test("matching is trailing-slash insensitive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  const { client, calls } = mockClient([{ name: "p", root_path: dir + "/" }]);
  const ix = makeIndexer(client);
  await ix.ensureIndexed(dir);
  expect(calls.index.length).toBe(0); // dir and dir+"/" canonicalise equal
});
