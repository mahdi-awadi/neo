// Host-level regression probe for the Codex read-only side-lane boundary. Uses disposable files,
// local listeners and an owned dummy process; never touches a real project, service or Docker.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexBinaryPath } from "../src/engine/codex-mcp-bridge";

const root = mkdtempSync(join(process.cwd(), ".neo-readonly-verify-"));
const home = mkdtempSync("/tmp/neo-readonly-home-");
const unixPath = join(home, "probe.sock");
const unix = createServer();
const tcp = createServer();
const dummy = spawn("sleep", ["60"], { stdio: "ignore" });
try {
  writeFileSync(join(home, "config.toml"), '[permissions.neo-lane]\nextends = ":read-only"\n');
  writeFileSync(join(root, "marker"), "safe\n");
  await new Promise<void>((resolve, reject) => { unix.once("error", reject); unix.listen(unixPath, resolve); });
  await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(0, "127.0.0.1", resolve); });
  const address = tcp.address();
  if (!address || typeof address === "string") throw new Error("Cannot create disposable TCP listener");
  const env = { ...process.env, CODEX_HOME: home };
  const run = (cmd: string[]) => spawnSync(codexBinaryPath(), ["sandbox", "-P", "neo-lane", "-C", root, "--", ...cmd], { env, encoding: "utf8", timeout: 10_000 });
  const readable = run(["cat", join(root, "marker")]);
  if (readable.status !== 0 || readable.stdout !== "safe\n") throw new Error("Read-only sandbox could not read the disposable project");
  const checks: Array<[string, string[]]> = [
    ["project write", ["touch", join(root, "forbidden")]],
    ["Unix socket", ["python3", "-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])", unixPath]],
    ["TCP connection", ["python3", "-c", "import socket,sys; socket.create_connection(('127.0.0.1',int(sys.argv[1])),timeout=2)", String(address.port)]],
    ["host process signal", ["kill", "-CONT", String(dummy.pid)]],
  ];
  for (const [name, cmd] of checks) {
    // Prove the same operation can succeed on the host; a missing binary or dead test listener
    // must not be mistaken for sandbox isolation.
    const host = spawnSync(cmd[0]!, cmd.slice(1), { env, encoding: "utf8", timeout: 10_000 });
    if (host.error || host.signal || host.status !== 0) throw new Error(`${name}: host baseline failed`);
    const result = run(cmd);
    if (result.error || result.signal || result.status === null) throw new Error(`${name}: sandbox probe did not complete`);
    if (result.status === 0) throw new Error(`${name}: read-only sandbox unexpectedly permitted the operation`);
  }
  console.log("PASS: project reads work; project writes, Unix/TCP connections, and host-process signals are blocked.");
} finally {
  dummy.kill();
  await Promise.all([new Promise<void>((resolve) => unix.close(() => resolve())), new Promise<void>((resolve) => tcp.close(() => resolve()))]);
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
