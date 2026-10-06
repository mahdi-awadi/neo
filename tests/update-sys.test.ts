import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realUpdateSys } from "../src/engine/update-sys";

// A minimal stdio MCP server: answers initialize, then tools/list with two tools.
const SERVER = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } } }));
    if (m.id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "a" }, { name: "b" }] } }));
  }
});
`;

test("probeMcp starts a stdio server, initializes it and counts its tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-probe-"));
  writeFileSync(join(dir, "server.js"), SERVER);
  const r = await realUpdateSys().probeMcp({ command: process.execPath, args: [join(dir, "server.js")] }, 10_000);
  expect(r).toEqual({ ok: true, tools: 2 });
});

test("probeMcp reports a server that never answers, and a command that does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-probe-"));
  writeFileSync(join(dir, "mute.js"), "setInterval(() => {}, 1000);");
  const mute = await realUpdateSys().probeMcp({ command: process.execPath, args: [join(dir, "mute.js")] }, 300);
  expect(mute.ok).toBe(false);
  expect(mute.error).toContain("no tools/list reply");
  const missing = await realUpdateSys().probeMcp({ command: "/nonexistent/neo-mcp", args: [] }, 300);
  expect(missing.ok).toBe(false);
});

test("exec returns the exit code and output, times out, and reports a missing binary as 127", async () => {
  const sys = realUpdateSys();
  expect(await sys.exec(["sh", "-c", "echo hi; exit 3"])).toMatchObject({ code: 3, out: "hi\n" });
  expect((await sys.exec(["sleep", "5"], { timeoutMs: 100 })).code).toBe(124);
  expect((await sys.exec(["/nonexistent/neo-bin"])).code).toBe(127);
});

test("writeFile is atomic and readFile/listDir/sha256 see the result", () => {
  const sys = realUpdateSys();
  const dir = mkdtempSync(join(tmpdir(), "neo-sys-"));
  sys.writeFile(join(dir, "a.json"), "{}");
  expect(sys.readFile(join(dir, "a.json"))).toBe("{}");
  expect(sys.sha256(join(dir, "a.json"))).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  expect(sys.listDir(dir)).toEqual([]);
  expect(sys.readFile(join(dir, "missing"))).toBeUndefined();
});
