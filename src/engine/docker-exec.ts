// A `docker exec` client of one tool call → the process it started INSIDE the container (ADR-0058).
// Killing the client on the host does not stop that process, so the engine finds the container's
// running exec instance whose command equals the client's (Docker Engine API over the local socket)
// and kills its host pid tree. An ambiguous match (identical running execs) kills nothing.

/** The Docker Engine API, read-only GETs. Injectable for tests. */
export interface DockerApi {
  get(path: string): Promise<unknown>;
}

/** The API over a unix socket (Bun's `fetch` `unix` option). A missing socket → undefined answers. */
export function dockerApiOverSocket(socket: string, timeoutMs = 5000): DockerApi {
  return {
    async get(path) {
      try {
        const res = await fetch(`http://docker${path}`, { unix: socket, signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
        return res.ok ? await res.json() : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** `docker` / `docker compose` flags that take a value (so the value is not the next word we look for). */
const VALUE_FLAGS = new Set(["-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir", "--detach-keys", "-f", "--file", "-p", "--project-name", "--project-directory", "--index", "-H", "--host", "--context", "-c", "--config", "--ansi", "--profile"]);

export type ExecTarget = { kind: "container"; name: string; cmd: string[] } | { kind: "service"; name: string; cmd: string[]; project: string | undefined };

/** What a `docker exec …` / `docker compose exec …` argv runs, and where. */
export function execTarget(argv: string[]): ExecTarget | undefined {
  if (argv[0] !== "docker" && !argv[0]?.endsWith("/docker")) return undefined;
  let i = 1;
  let compose = false;
  let project: string | undefined;
  const skipFlags = () => {
    while (i < argv.length && argv[i]!.startsWith("-")) {
      const f = argv[i]!;
      if ((f === "-p" || f === "--project-name") && argv[i + 1]) project = argv[i + 1];
      i += VALUE_FLAGS.has(f) ? 2 : 1;
    }
  };
  skipFlags();
  if (argv[i] === "compose") {
    compose = true;
    i++;
    skipFlags();
  }
  if (argv[i] !== "exec") return undefined;
  i++;
  skipFlags();
  const name = argv[i];
  if (!name) return undefined;
  const cmd = argv.slice(i + 1);
  return compose ? { kind: "service", name, cmd, project } : { kind: "container", name, cmd };
}

type ExecJson = { Running?: boolean; Pid?: number; ProcessConfig?: { entrypoint?: string; arguments?: string[] } };

/** The host pids of the in-container processes one client started. `note` says why none were found. */
export async function execPidsFor(
  client: { argv: string[]; cwd?: string; startedAt?: number },
  api: DockerApi,
  startOf?: (pid: number) => number | undefined,
): Promise<{ pids: number[]; note?: string }> {
  const t = execTarget(client.argv);
  if (!t) return { pids: [] };
  let containerId: string | undefined;
  if (t.kind === "container") {
    containerId = t.name;
  } else {
    // A compose service: the container of that service in the client's project (its folder, or -p).
    const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.service=${t.name}`] }));
    const list = ((await api.get(`/containers/json?filters=${filter}`)) as Array<{ Id: string; Labels?: Record<string, string> }> | undefined) ?? [];
    // Never guess the project: without -p and without the client's folder, nothing matches.
    if (!t.project && !client.cwd) return { pids: [], note: `compose service ${t.name}: its project is unknown` };
    const mine = list.filter((c) =>
      t.project ? c.Labels?.["com.docker.compose.project"] === t.project : c.Labels?.["com.docker.compose.project.working_dir"] === client.cwd,
    );
    if (mine.length !== 1) return { pids: [], note: `compose service ${t.name}: ${mine.length} matching containers` };
    containerId = mine[0]!.Id;
  }
  const c = (await api.get(`/containers/${encodeURIComponent(containerId)}/json`)) as { ExecIDs?: string[] | null } | undefined;
  if (!c) return { pids: [], note: `container ${t.name} not found (or Docker unreachable)` };
  const want = JSON.stringify(t.cmd);
  const matches: number[] = [];
  for (const id of c.ExecIDs ?? []) {
    const e = (await api.get(`/exec/${encodeURIComponent(id)}/json`)) as ExecJson | undefined;
    if (!e?.Running || !e.Pid || !e.ProcessConfig?.entrypoint) continue;
    if (JSON.stringify([e.ProcessConfig.entrypoint, ...(e.ProcessConfig.arguments ?? [])]) !== want) continue;
    // Our client started this exec, so the exec is never older than the client: an older one is another's.
    const execStart = startOf?.(e.Pid);
    if (client.startedAt !== undefined && execStart !== undefined && execStart < client.startedAt) continue;
    matches.push(e.Pid);
  }
  if (matches.length > 1) return { pids: [], note: `${t.name}: ${matches.length} identical running execs of \`${t.cmd.join(" ")}\` — none stopped (ambiguous)` };
  return matches.length ? { pids: matches } : { pids: [], note: `${t.name}: no running exec of \`${t.cmd.join(" ")}\`` };
}
